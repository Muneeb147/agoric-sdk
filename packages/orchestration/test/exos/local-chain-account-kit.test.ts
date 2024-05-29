import { test } from '@agoric/zoe/tools/prepare-test-env-ava.js';

import { AmountMath } from '@agoric/ertp';
import { makeMockChainStorageRoot } from '@agoric/internal/src/storage-test-utils.js';
import { makeScalarBigMapStore } from '@agoric/vat-data';
import { prepareRecorderKitMakers } from '@agoric/zoe/src/contractSupport/recorder.js';
import { E, Far } from '@endo/far';
import { prepareLocalChainAccountKit } from '../../src/exos/local-chain-account-kit.js';
import { ChainAddress } from '../../src/orchestration-api.js';
import { prepareMockChainInfo } from '../../src/utils/mockChainInfo.js';
import { NANOSECONDS_PER_SECOND } from '../../src/utils/time.js';
import { commonSetup } from '../supports.js';

test('transfer', async t => {
  const { bootstrap, brands, utils } = await commonSetup(t);

  const { bld: stake } = brands;

  const { timer, localchain, marshaller, rootZone } = bootstrap;

  t.log('chainInfo mocked via `prepareMockChainInfo` until #8879');
  const agoricChainInfo = prepareMockChainInfo(rootZone.subZone('chainInfo'));

  t.log('exo setup - prepareLocalChainAccountKit');
  const baggage = makeScalarBigMapStore<string, unknown>('baggage', {
    durable: true,
  });
  const { makeRecorderKit } = prepareRecorderKitMakers(baggage, marshaller);
  const makeLocalChainAccountKit = prepareLocalChainAccountKit(
    baggage,
    makeRecorderKit,
    // @ts-expect-error mocked zcf. use `stake-bld.contract.test.ts` to test LCA with offer
    Far('MockZCF', {}),
    timer,
    timer.getTimerBrand(),
    agoricChainInfo,
  );

  t.log('request account from vat-localchain');
  const lca = await E(localchain).makeAccount();
  const address = await E(lca).getAddress();

  t.log('make a LocalChainAccountKit');
  const { holder: account } = makeLocalChainAccountKit({
    account: lca,
    address,
    storageNode: makeMockChainStorageRoot().makeChildNode('lcaKit'),
  });

  t.truthy(account, 'account is returned');
  t.regex(await E(account).getAddress(), /agoric1/);

  const oneHundredStakePmt = await utils.pourPayment(stake.units(100));

  t.log('deposit 100 bld to account');
  const depositResp = await E(account).deposit(oneHundredStakePmt);
  t.true(AmountMath.isEqual(depositResp, stake.units(100)), 'deposit');

  const destination: ChainAddress = {
    chainId: 'cosmoslocal',
    address: 'cosmos1pleab',
    addressEncoding: 'bech32',
  };

  // TODO #9211, support ERTP amounts
  t.log('ERTP Amounts not yet supported for AmountArg');
  await t.throwsAsync(() => E(account).transfer(stake.units(1), destination), {
    message: 'ERTP Amounts not yet supported',
  });

  t.log('.transfer() 1 bld to cosmos using DenomAmount');
  const transferResp = await E(account).transfer(
    { denom: 'ubld', value: 1_000_000n },
    destination,
  );
  t.is(transferResp, undefined, 'Successful transfer returns Promise<void>.');

  await t.throwsAsync(
    () => E(account).transfer({ denom: 'ubld', value: 504n }, destination),
    {
      message: 'simulated unexpected MsgTransfer packet timeout',
    },
  );

  const unknownDestination: ChainAddress = {
    chainId: 'fakenet',
    address: 'fakenet1pleab',
    addressEncoding: 'bech32',
  };
  await t.throwsAsync(
    () => E(account).transfer({ denom: 'ubld', value: 1n }, unknownDestination),
    {
      message: /not found(.*)fakenet/,
    },
    'cannot create transfer msg with unknown chainId',
  );

  await t.notThrowsAsync(
    () =>
      E(account).transfer({ denom: 'ubld', value: 10n }, destination, {
        memo: 'hello',
      }),
    'can create transfer msg with memo',
  );
  // TODO, intercept/spy the bridge message to see that it has a memo

  await t.notThrowsAsync(
    () =>
      E(account).transfer({ denom: 'ubld', value: 10n }, destination, {
        // sets to current time, which shouldn't work in a real env
        timeoutTimestamp: BigInt(new Date().getTime()) * NANOSECONDS_PER_SECOND,
      }),
    'accepts custom timeoutTimestamp',
  );

  await t.notThrowsAsync(
    () =>
      E(account).transfer({ denom: 'ubld', value: 10n }, destination, {
        timeoutHeight: { revisionHeight: 100n, revisionNumber: 1n },
      }),
    'accepts custom timeoutHeight',
  );
});
