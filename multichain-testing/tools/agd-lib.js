// @ts-check
import assert from 'node:assert';

const { freeze } = Object;

const kubectlBinary = 'kubectl';
const binaryArgs = [
  'exec',
  '-i',
  'agoriclocal-genesis-0',
  '-c',
  'validator',
  '--tty=false',
  '--',
  'agd',
];

/**
 * @param {Record<string, string | undefined>} record - e.g. { color: 'blue' }
 * @returns {string[]} - e.g. ['--color', 'blue']
 */
export const flags = record => {
  // TODO? support --yes with boolean?

  /** @type {[string, string][]} */
  // @ts-expect-error undefined is filtered out
  const skipUndef = Object.entries(record).filter(([_k, v]) => v !== undefined);
  return skipUndef.map(([k, v]) => [`--${k}`, v]).flat();
};

/**
 * @callback ExecSync
 * @param {string} file
 * @param {string[]} args
 * @param {{ [k: string]: unknown }} [opts]
 * @returns {string}
 */

/**
 * @typedef {(...args: Parameters<ExecSync>) => Promise<ReturnType<ExecSync>>} ExecAsync
 */

/**
 * @param {ExecAsync} [execFileAsync]
 * @param {ExecSync} [execFileSync]
 * @returns {ExecAsync}
 */
const makeExecFileAsync = (execFileAsync, execFileSync) => {
  if (execFileAsync) {
    return execFileAsync;
  }
  if (!execFileSync) {
    throw TypeError('execFileAsync or execFileSync required');
  }
  return async (...args) => {
    return execFileSync(...args);
  };
};

/**
 * @param {{ execFileSync: ExecSync, execFileAsync?: ExecAsync }} io
 */
export const makeAgd = ({ execFileSync, execFileAsync: rawExecFileAsync }) => {
  const execFileAsync = makeExecFileAsync(rawExecFileAsync, execFileSync);

  /**
   * @param { {
   *       home?: string;
   *       keyringBackend?: string;
   *       rpcAddrs?: string[];
   *     }} opts
   */
  const make = ({ home, keyringBackend, rpcAddrs } = {}) => {
    const keyringArgs = flags({ home, 'keyring-backend': keyringBackend });
    if (rpcAddrs) {
      assert.equal(
        rpcAddrs.length,
        1,
        'XXX rpcAddrs must contain only one entry',
      );
    }
    const nodeArgs = flags({ node: rpcAddrs && rpcAddrs[0] });

    /**
     * @param {string[]} args
     * @param {*} [opts]
     */
    const exec = (
      args,
      opts = { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    ) => execFileSync(kubectlBinary, [...binaryArgs, ...args], opts);

    /**
     * @param {string[]} args
     * @param {Parameters<ExecSync>[2]} [opts]
     */
    const execAsync = async (
      args,
      opts = { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    ) => execFileAsync(kubectlBinary, [...binaryArgs, ...args], opts);

    const outJson = flags({ output: 'json' });

    const ro = freeze({
      status: async () => JSON.parse(exec([...nodeArgs, 'status'])),
      /**
       * @param {| [kind: 'gov', domain: string, ...rest: any]
       *         | [kind: 'tx', txhash: string]
       *         | [mod: 'vstorage', kind: 'data' | 'children', path: string]
       * } qArgs
       */
      query: async qArgs => {
        const out = exec(['query', ...qArgs, ...nodeArgs, ...outJson], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });

        try {
          return JSON.parse(out);
        } catch (e) {
          console.error(e);
          console.info('output:', out);
        }
      },
    });
    const nameHub = freeze({
      /**
       * NOTE: synchronous I/O
       *
       * @param {string[]} path
       */
      lookup: (...path) => {
        if (!Array.isArray(path)) {
          // TODO: use COND || Fail``
          throw TypeError();
        }
        if (path.length !== 1) {
          throw Error(`path length limited to 1: ${path.length}`);
        }
        const [name] = path;
        const txt = exec(['keys', 'show', `--address`, name, ...keyringArgs]);
        return txt.trim();
      },
    });
    const rw = freeze({
      /**
       * TODO: gas
       * @param {string[]} txArgs
       * @param {{ chainId: string; from: string; yes?: boolean }} opts
       */
      tx: async (txArgs, { chainId, from, yes }) => {
        const args = [
          'tx',
          ...txArgs,
          ...nodeArgs,
          ...keyringArgs,
          ...flags({ 'chain-id': chainId, from }),
          ...flags({
            'broadcast-mode': 'block',
            gas: 'auto',
            'gas-adjustment': '1.4',
          }),
          ...(yes ? ['--yes'] : []),
          ...outJson,
        ];
        console.log('$$$ agd', ...args);
        // This is practically the only command that takes longer than the
        // default AVA 10s timeout.
        const out = await execAsync(args, {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        try {
          const detail = JSON.parse(out);
          if (detail.code !== 0) {
            throw Error(detail.raw_log);
          }
          return detail;
        } catch (e) {
          console.error(e);
          console.info('output:', out);
        }
      },
      ...ro,
      ...nameHub,
      readOnly: () => ro,
      nameHub: () => nameHub,
      keys: {
        /**
         * @param {string} name
         * @param {string} mnemonic
         */
        add: (name, mnemonic) => {
          return execFileSync(
            kubectlBinary,
            [...binaryArgs, ...keyringArgs, 'keys', 'add', name, '--recover'],
            {
              encoding: 'utf-8',
              input: mnemonic,
              stdio: ['pipe', 'pipe', 'ignore'],
            },
          ).toString();
        },
        /** @param {string} name */
        delete: name => {
          return exec([...keyringArgs, 'keys', 'delete', name, '-y'], {
            stdio: ['pipe', 'pipe', 'ignore'],
          });
        },
      },
      /**
       * @param {Record<string, unknown>} opts
       */
      withOpts: opts => make({ home, keyringBackend, rpcAddrs, ...opts }),
    });
    return rw;
  };
  return make();
};

/** @typedef {ReturnType<makeAgd>} Agd */

/** @param {{execFileSync?: ExecSync, execFileAsync?: ExecAsync, log: typeof console.log }} powers */
export const makeCopyFiles = (
  { execFileSync, execFileAsync: rawExecFileAsync, log },
  {
    podName = 'agoriclocal-genesis-0',
    containerName = 'validator',
    destDir = '/tmp/contracts',
  } = {},
) => {
  // Provide a default execFileAsync if it's not specified.
  /** @type {ExecAsync} */
  const execFileAsync = makeExecFileAsync(rawExecFileAsync, execFileSync);

  /** @param {string[]} paths } */
  return async paths => {
    // Create the destination directory if it doesn't exist
    await execFileAsync(
      kubectlBinary,
      `exec -i ${podName} -c ${containerName} -- mkdir -p ${destDir}`.split(
        ' ',
      ),
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    for (const path of paths) {
      await execFileAsync(
        kubectlBinary,
        `cp ${path} ${podName}:${destDir}/ -c ${containerName}`.split(' '),
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      log(`Copied ${path} to ${destDir} in pod ${podName}`);
    }
    const lsOutput = await execFileAsync(
      kubectlBinary,
      `exec -i ${podName} -c ${containerName}  -- ls ${destDir}`.split(' '),
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' },
    );
    log(`ls ${destDir}:\n${lsOutput}`);
    return lsOutput;
  };
};
