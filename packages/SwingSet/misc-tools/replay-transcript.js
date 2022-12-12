/* global WeakRef FinalizationRegistry */
/* eslint-disable no-constant-condition */
import fs from 'fs';
// import '@endo/init';
import '../tools/install-ses-debug.js';
import zlib from 'zlib';
import readline from 'readline';
import process from 'process';
import { spawn } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import { createHash } from 'crypto';
import { pipeline } from 'stream';
import { performance } from 'perf_hooks';
// eslint-disable-next-line import/no-extraneous-dependencies
import { file as tmpFile, tmpName } from 'tmp';
import bundleSource from '@endo/bundle-source';
import { makeMeasureSeconds } from '@agoric/internal';
import { makeSnapStore } from '@agoric/swing-store';
import { waitUntilQuiescent } from '../src/lib-nodejs/waitUntilQuiescent.js';
import { makeStartXSnap } from '../src/controller/controller.js';
import { makeXsSubprocessFactory } from '../src/kernel/vat-loader/manager-subprocess-xsnap.js';
import { makeLocalVatManagerFactory } from '../src/kernel/vat-loader/manager-local.js';
import { makeNodeSubprocessFactory } from '../src/kernel/vat-loader/manager-subprocess-node.js';
import { startSubprocessWorker } from '../src/lib-nodejs/spawnSubprocessWorker.js';
import {
  extraSyscall,
  missingSyscall,
  requireIdenticalExceptStableVCSyscalls,
} from '../src/kernel/vat-loader/transcript.js';
import { makeDummyMeterControl } from '../src/kernel/dummyMeterControl.js';
import { makeGcAndFinalize } from '../src/lib-nodejs/gc-and-finalize.js';
import engineGC from '../src/lib-nodejs/engine-gc.js';

// Set the absolute path of the SDK to use for bundling
// This can help if there are symlinks in the path that should be respected
// to match the path of the SDK that produced the initial transcript
// For e.g. set to '/src' if replaying a docker based loadgen transcript
const ABSOLUTE_SDK_PATH = null;

// Rebuild the bundles when starting the replay.
// Disable if bundles were previously extracted form a Kernel DB, or
// to save a few seconds and rely upon previously built versions instead
const REBUILD_BUNDLES = false;

// Enable to continue if snapshot hash doesn't match transcript
const IGNORE_SNAPSHOT_HASH_DIFFERENCES = true;

const FORCED_SNAPSHOT_INITIAL = 2;
const FORCED_SNAPSHOT_INTERVAL = 1000;
const FORCED_RELOAD_FROM_SNAPSHOT = true;
const KEEP_WORKER_RECENT = 10;
const KEEP_WORKER_INITIAL = 2;
const KEEP_WORKER_INTERVAL = 10;
const KEEP_WORKER_TRANSACTION_NUMS = [
  69002, 70002, 86002, 87002, 108002, 111002, 114002, 115002, 118002, 127002,
  128002, 129002, 131002, 134002, 135002, 139002, 141002, 142002, 143002,
  144002, 145002, 146002, 147002, 151002, 156002, 159002, 160002, 161002,
  162002, 163002,
];

const SKIP_EXTRA_SYSCALLS = true;
const SIMULATE_VC_SYSCALLS = true;

// Use a simplified snapstore which derives the snapshot filename from the
// transcript and doesn't compress the snapshot
const USE_CUSTOM_SNAP_STORE = false;

// Enable to output xsnap debug traces corresponding to the transcript replay
const RECORD_XSNAP_TRACE = false;

const USE_XSNAP_DEBUG = false;

const pipe = promisify(pipeline);

/** @type {(filename: string) => Promise<string>} */
async function fileHash(filename) {
  const hash = createHash('sha256');
  const input = fs.createReadStream(filename);
  await pipe(input, hash);
  return hash.digest('hex');
}

function makeSnapStoreIO() {
  return {
    createReadStream: fs.createReadStream,
    createWriteStream: fs.createWriteStream,
    fsync: fs.fsync,
    measureSeconds: makeMeasureSeconds(performance.now),
    open: fs.promises.open,
    rename: fs.promises.rename,
    resolve: path.resolve,
    stat: fs.promises.stat,
    tmpFile,
    tmpName,
    unlink: fs.promises.unlink,
  };
}

async function makeBundles() {
  const controllerUrl = new URL(
    `${
      ABSOLUTE_SDK_PATH ? `${ABSOLUTE_SDK_PATH}/packages/SwingSet` : '..'
    }/src/controller/initializeSwingset.js`,
    import.meta.url,
  );

  const srcGE = rel =>
    bundleSource(new URL(rel, controllerUrl).pathname, 'getExport');
  const lockdown = await srcGE(
    '../supervisors/subprocess-xsnap/lockdown-subprocess-xsnap.js',
  );
  const supervisor = await srcGE(
    '../supervisors/subprocess-xsnap/supervisor-subprocess-xsnap.js',
  );
  fs.writeFileSync('lockdown-bundle', JSON.stringify(lockdown));
  fs.writeFileSync('supervisor-bundle', JSON.stringify(supervisor));
  console.log(`xs bundles written`);
}

// relative timings:
// 3.8s v8-false, 27.5s v8-gc
// 10.8s xs-no-gc, 15s xs-gc
const worker = 'xs-worker';

async function replay(transcriptFile) {
  let vatID; // we learn this from the first line of the transcript
  let factory;

  let loadSnapshotID = null;
  let saveSnapshotID = null;
  let lastTranscriptNum;
  let startTranscriptNum;
  const snapshotOverrideMap = new Map();

  const snapshotActivityFd = fs.openSync('snapshot-activity.jsonl', 'a');

  const fakeKernelKeeper = {
    provideVatKeeper: _vatID => ({
      addToTranscript: () => undefined,
      getLastSnapshot: () => loadSnapshotID && { snapshotID: loadSnapshotID },
    }),
    getRelaxDurabilityRules: () => false,
  };
  const kernelSlog = {
    write() {},
    delivery: () => () => undefined,
    syscall: () => () => undefined,
  };
  const snapStore = USE_CUSTOM_SNAP_STORE
    ? {
        async save(saveRaw) {
          const snapFile = `${saveSnapshotID || 'unknown'}.xss`;
          await saveRaw(snapFile);
          const hash = await fileHash(snapFile);
          const filePath = `${hash}.xss`;
          await fs.promises.rename(snapFile, filePath);
          return { hash, filePath };
        },
        async load(hash, loadRaw) {
          const snapFile = `${hash}.xss`;
          return loadRaw(snapFile);
        },
      }
    : makeSnapStore(process.cwd(), makeSnapStoreIO(), { keepSnapshots: true });
  const testLog = undefined;
  const meterControl = makeDummyMeterControl();
  const gcTools = harden({
    WeakRef,
    FinalizationRegistry,
    waitUntilQuiescent,
    gcAndFinalize: makeGcAndFinalize(engineGC),
    meterControl,
  });
  const allVatPowers = { testLog };
  const workers = [];

  if (worker === 'xs-worker') {
    // eslint-disable-next-line no-constant-condition
    if (REBUILD_BUNDLES) {
      console.log(`creating xsnap helper bundles`);
      await makeBundles();
      console.log(`xsnap helper bundles created`);
    }
    const bundles = [
      JSON.parse(fs.readFileSync('lockdown-bundle')),
      JSON.parse(fs.readFileSync('supervisor-bundle')),
    ];
    const env = { XSNAP_DEBUG: USE_XSNAP_DEBUG };
    if (RECORD_XSNAP_TRACE) {
      env.XSNAP_TEST_RECORD = process.cwd();
    }

    const capturePIDSpawn = (...args) => {
      const child = spawn(...args);
      workers[workers.length - 1].xsnapPID = child.pid;
      return child;
    };
    const startXSnap = makeStartXSnap(bundles, {
      snapStore,
      env,
      spawn: capturePIDSpawn,
    });
    factory = makeXsSubprocessFactory({
      kernelKeeper: fakeKernelKeeper,
      kernelSlog,
      startXSnap,
      testLog,
    });
  } else if (worker === 'local') {
    factory = makeLocalVatManagerFactory({
      allVatPowers,
      kernelKeeper: fakeKernelKeeper,
      vatEndowments: {},
      gcTools,
      kernelSlog,
    });
  } else if (worker === 'node-subprocess') {
    // this worker type cannot do blocking syscalls like vatstoreGet, so it's
    // kind of useless for vats that use virtual objects
    function startSubprocessWorkerNode() {
      const supercode = new URL(
        '../src/supervisors/subprocess-node/supervisor-subprocess-node.js',
        import.meta.url,
      ).pathname;
      return startSubprocessWorker(process.execPath, ['-r', 'esm', supercode]);
    }
    factory = makeNodeSubprocessFactory({
      startSubprocessWorker: startSubprocessWorkerNode,
      kernelKeeper: fakeKernelKeeper,
      kernelSlog,
      testLog,
    });
  } else {
    throw Error(`unhandled worker type ${worker}`);
  }

  let vatParameters;
  let vatSourceBundle;

  const knownVCSyscalls = new Map();
  const vcSyscallRE = /^vc\.\d+\.\|(?:schemata|label)$/;

  const vatSyscallHandler = vso => {
    if (vso[0] === 'vatstoreGet') {
      const response = knownVCSyscalls.get(vso[1]);

      if (!response) {
        throw new Error(`Unknown vc vatstore entry ${vso[1]}`);
      }

      return response;
    }

    throw new Error(`Unexpected syscall ${vso[0]}(${vso.slice(1).join(', ')})`);
  };

  const makeCompareSyscalls =
    workerData => (_vatID, originalSyscall, newSyscall, originalResponse) => {
      const error = requireIdenticalExceptStableVCSyscalls(
        vatID,
        originalSyscall,
        newSyscall,
      );
      if (
        error &&
        JSON.stringify(originalSyscall).indexOf('error:liveSlots') !== -1
      ) {
        return undefined; // Errors are serialized differently, sometimes
      }

      if (error) {
        console.error(
          `during transcript num= ${lastTranscriptNum} for worker PID ${workerData.xsnapPID} (start delivery ${workerData.firstTranscriptNum})`,
        );

        if (error === extraSyscall && !SKIP_EXTRA_SYSCALLS) {
          return new Error('Extra syscall disallowed');
        }
      }

      const newSyscallKind = newSyscall[0];

      if (error === missingSyscall && !SIMULATE_VC_SYSCALLS) {
        return new Error('Missing syscall disallowed');
      }

      if (
        SIMULATE_VC_SYSCALLS &&
        !error &&
        (newSyscallKind === 'vatstoreGet' ||
          newSyscallKind === 'vatstoreSet') &&
        vcSyscallRE.test(newSyscall[1])
      ) {
        if (newSyscallKind === 'vatstoreGet') {
          knownVCSyscalls.set(newSyscall[1], originalResponse);
        } else if (newSyscallKind === 'vatstoreSet') {
          knownVCSyscalls.set(newSyscall[1], ['ok', newSyscall[2]]);
        }
      }

      return error;
    };

  const createManager = async () => {
    const workerData = {
      manager: null,
      xsnapPID: NaN,
      deliveryTimeTotal: 0,
      deliveryTimeSinceLastSnapshot: 0,
      loadSnapshotID,
      firstTranscriptNum: undefined,
    };
    workers.push(workerData);
    const managerOptions = {
      sourcedConsole: console,
      vatParameters,
      compareSyscalls: makeCompareSyscalls(workerData),
      useTranscript: true,
    };
    workerData.manager = await factory.createFromBundle(
      vatID,
      vatSourceBundle,
      managerOptions,
      {},
      vatSyscallHandler,
    );
    return workerData;
  };

  let loadLock = Promise.resolve();
  const loadSnapshot = async data => {
    await loadLock;

    await Promise.all(
      workers
        .filter(
          ({ firstTranscriptNum }, idx) =>
            firstTranscriptNum != null &&
            !(
              (KEEP_WORKER_INTERVAL &&
                Math.floor(
                  (firstTranscriptNum - startTranscriptNum) /
                    FORCED_SNAPSHOT_INTERVAL,
                ) %
                  KEEP_WORKER_INTERVAL ===
                  0) ||
              idx < KEEP_WORKER_INITIAL ||
              idx >= workers.length - KEEP_WORKER_RECENT ||
              KEEP_WORKER_TRANSACTION_NUMS.includes(firstTranscriptNum)
            ),
        )
        .map(async workerData => {
          workers.splice(workers.indexOf(workerData), 1);

          const {
            manager,
            xsnapPID,
            deliveryTimeSinceLastSnapshot,
            deliveryTimeTotal,
            firstTranscriptNum,
          } = workerData;
          // eslint-disable-next-line no-await-in-loop
          await manager.shutdown();
          console.log(
            `Shutdown worker PID ${xsnapPID} (start delivery ${firstTranscriptNum}).\n    Delivery time since last snapshot ${
              Math.round(deliveryTimeSinceLastSnapshot) / 1000
            }s. Delivery time total ${
              Math.round(deliveryTimeTotal) / 1000
            }s. Up ${lastTranscriptNum - firstTranscriptNum} deliveries.`,
          );
        }),
    );

    loadSnapshotID = data.snapshotID;
    let releaseLock;
    loadLock = new Promise(resolve => {
      releaseLock = resolve;
    });
    try {
      if (snapshotOverrideMap.has(loadSnapshotID)) {
        loadSnapshotID = snapshotOverrideMap.get(loadSnapshotID);
      }
      if (
        workers.find(workerData => workerData.loadSnapshotID === loadSnapshotID)
      ) {
        console.log(
          `found an existing manager for snapshot ${loadSnapshotID}, skipping duplicate creation`,
        );
        return;
      }
      if (data.vatID) {
        vatID = data.vatID;
      }
      const { xsnapPID } = await createManager();
      console.log(
        `created manager from snapshot ${loadSnapshotID}, worker PID: ${xsnapPID}`,
      );
      fs.writeSync(
        snapshotActivityFd,
        `${JSON.stringify({
          transcriptFile,
          type: 'load',
          xsnapPID,
          vatID,
          snapshotID: data.snapshotID,
          loadSnapshotID,
        })}\n`,
      );
    } finally {
      loadSnapshotID = null;
      releaseLock();
    }
  };

  let transcriptF = fs.createReadStream(transcriptFile);
  if (transcriptFile.endsWith('.gz')) {
    transcriptF = transcriptF.pipe(zlib.createGunzip());
  }
  const lines = readline.createInterface({ input: transcriptF });
  let lineNumber = 1;
  for await (const line of lines) {
    if (lineNumber % 1000 === 0) {
      console.log(` (slog line ${lineNumber})`);
    }
    lineNumber += 1;
    const data = JSON.parse(line);
    if (data.type === 'heap-snapshot-load') {
      await loadSnapshot(data);
    } else if (!workers.length) {
      if (data.type !== 'create-vat') {
        throw Error(
          `first line of transcript was not a create-vat or heap-snapshot-load`,
        );
      }
      ({ vatParameters, vatSourceBundle } = data);
      vatID = data.vatID;
      const { xsnapPID } = await createManager();
      console.log(
        `manager created from bundle source, worker PID: ${xsnapPID}`,
      );
      fs.writeSync(
        snapshotActivityFd,
        `${JSON.stringify({
          transcriptFile,
          type: 'create',
          xsnapPID,
          vatID,
        })}\n`,
      );
    } else if (data.type === 'heap-snapshot-save') {
      saveSnapshotID = data.snapshotID;
      await Promise.all(
        workers.map(async workerData => {
          const { manager, xsnapPID, firstTranscriptNum } = workerData;
          const { hash, rawSaveSeconds } = await manager.makeSnapshot(
            snapStore,
          );
          snapshotOverrideMap.set(saveSnapshotID, hash);
          fs.writeSync(
            snapshotActivityFd,
            `${JSON.stringify({
              transcriptFile,
              type: 'save',
              xsnapPID,
              vatID,
              transcriptNum: lastTranscriptNum,
              snapshotID: hash,
              saveSnapshotID,
            })}\n`,
          );
          if (hash !== saveSnapshotID) {
            const errorMessage = `Snapshot hash does not match. ${hash} !== ${saveSnapshotID} for worker PID ${xsnapPID} (start delivery ${firstTranscriptNum})`;
            if (IGNORE_SNAPSHOT_HASH_DIFFERENCES) {
              console.warn(errorMessage);
            } else {
              throw new Error(errorMessage);
            }
          } else {
            console.log(
              `made snapshot ${hash} of worker PID ${xsnapPID} (start delivery ${firstTranscriptNum}).\n    Save time = ${
                Math.round(rawSaveSeconds * 1000) / 1000
              }s. Delivery time since last snapshot ${
                Math.round(workerData.deliveryTimeSinceLastSnapshot) / 1000
              }s. Up ${
                lastTranscriptNum - workerData.firstTranscriptNum
              } deliveries.`,
            );
          }
          workerData.deliveryTimeSinceLastSnapshot = 0;
        }),
      );
      saveSnapshotID = null;
      if (FORCED_RELOAD_FROM_SNAPSHOT) {
        await loadSnapshot(data);
      }
    } else {
      const { transcriptNum, d: delivery, syscalls } = data;
      lastTranscriptNum = transcriptNum;
      if (startTranscriptNum == null) {
        startTranscriptNum = transcriptNum - 1;
      }
      const makeSnapshot =
        FORCED_SNAPSHOT_INTERVAL &&
        (transcriptNum - FORCED_SNAPSHOT_INITIAL) % FORCED_SNAPSHOT_INTERVAL ===
          0;
      // syscalls = [{ d, response }, ..]
      // console.log(`replaying:`);
      // console.log(
      //   `delivery ${transcriptNum} (L ${lineNumber}):`,
      //   JSON.stringify(delivery).slice(0, 200),
      // );
      // for (const s of syscalls) {
      //   // s.response = 'nope';
      //   console.log(
      //     ` syscall:`,
      //     s.response[0],
      //     JSON.stringify(s.d).slice(0, 200),
      //     JSON.stringify(s.response[1]).slice(0, 200),
      //   );
      // }
      const start = performance.now();
      const snapshotIDs = await Promise.all(
        workers.map(async workerData => {
          const { manager, xsnapPID } = workerData;
          await manager.replayOneDelivery(delivery, syscalls, transcriptNum);
          const deliveryTime = performance.now() - start;
          workerData.deliveryTimeTotal += deliveryTime;
          workerData.deliveryTimeSinceLastSnapshot += deliveryTime;
          workerData.firstTranscriptNum ??= transcriptNum - 1;

          // console.log(`dr`, dr);

          // enable this to write periodic snapshots, for #5975 leak
          if (makeSnapshot) {
            const { hash: snapshotID, rawSaveSeconds } =
              await manager.makeSnapshot(snapStore);
            fs.writeSync(
              snapshotActivityFd,
              `${JSON.stringify({
                transcriptFile,
                type: 'save',
                xsnapPID,
                vatID,
                transcriptNum,
                snapshotID,
              })}\n`,
            );
            console.log(
              `made snapshot ${snapshotID} after delivery ${transcriptNum} to worker PID ${xsnapPID} (start delivery ${
                workerData.firstTranscriptNum
              }).\n    Save time = ${
                Math.round(rawSaveSeconds * 1000) / 1000
              }s. Delivery time since last snapshot ${
                Math.round(workerData.deliveryTimeSinceLastSnapshot) / 1000
              }s. Up ${
                transcriptNum - workerData.firstTranscriptNum
              } deliveries.`,
            );
            workerData.deliveryTimeSinceLastSnapshot = 0;
            return snapshotID;
          } else {
            return undefined;
          }
        }),
      );
      const uniqueSnapshotIDs = [...new Set(snapshotIDs)].filter(
        snapshotID => snapshotID != null,
      );

      if (makeSnapshot && uniqueSnapshotIDs.length !== 1) {
        const errorMessage = `Snapshot hashes do not match each other: ${uniqueSnapshotIDs.join(
          ', ',
        )}`;
        if (IGNORE_SNAPSHOT_HASH_DIFFERENCES) {
          console.warn(errorMessage);
        } else {
          throw new Error(errorMessage);
        }
      }

      if (FORCED_RELOAD_FROM_SNAPSHOT) {
        for (const snapshotID of uniqueSnapshotIDs) {
          // eslint-disable-next-line no-await-in-loop
          await loadSnapshot({
            snapshotID,
            vatID,
          });
        }
      }
    }
  }

  lines.close();
  fs.closeSync(snapshotActivityFd);
  await Promise.all(
    workers.map(
      async ({
        xsnapPID,
        manager,
        deliveryTimeSinceLastSnapshot,
        deliveryTimeTotal,
        firstTranscriptNum,
      }) => {
        await manager.shutdown();
        console.log(
          `Shutdown worker PID ${xsnapPID} (start delivery ${firstTranscriptNum}).\n    Delivery time since last snapshot ${
            Math.round(deliveryTimeSinceLastSnapshot) / 1000
          }s. Delivery time total ${
            Math.round(deliveryTimeTotal) / 1000
          }s. Up ${lastTranscriptNum - firstTranscriptNum} deliveries.`,
        );
      },
    ),
  );
}

async function run() {
  const args = process.argv.slice(2);
  console.log(`argv`, args);
  if (args.length < 1) {
    console.log(`replay-transcript.js transcript.sst`);
    return;
  }
  const [transcriptFile] = args;
  console.log(`using transcript ${transcriptFile}`);
  await replay(transcriptFile);
}

run().catch(err => console.log('RUN ERR', err));
