import '@endo/init/debug.js';

import test from 'ava';

import { buffer } from '../src/util.js';
import { initSwingStore, makeSwingStoreExporter } from '../src/index.js';

import { tmpDir, getSnapshotStream, makeB0ID } from './util.js';

const snapshotData = 'snapshot data';
// this snapHash was computed manually
const snapHash =
  'e7dee7266896538616b630a5da40a90e007726a383e005a9c9c5dd0c2daf9329';

/** @type {import('../src/bundleStore.js').Bundle} */
const bundle0 = { moduleFormat: 'nestedEvaluate', source: '1+1' };
const bundle0ID = makeB0ID(bundle0);

const exportTest = test.macro(async (t, mode) => {
  const [dbDir, cleanup] = await tmpDir('testdb');
  t.teardown(cleanup);
  // const dbDir = 't-db';

  const options = {};
  if (mode === 'debug') {
    options.keepSnapshots = true; // else old snapshots are deleted
  }
  const ss1 = initSwingStore(dbDir, options);
  const ks = ss1.kernelStorage;

  // build a DB with three spans (only one inUse) and two snapshots (same)

  ks.kvStore.set('key1', 'value1');
  ks.bundleStore.addBundle(bundle0ID, bundle0);
  ks.transcriptStore.initTranscript('v1');

  ks.transcriptStore.addItem('v1', 'start-worker'); // 0
  ks.transcriptStore.addItem('v1', 'delivery1'); // 1
  await ks.snapStore.saveSnapshot('v1', 2, getSnapshotStream(snapshotData));
  ks.transcriptStore.addItem('v1', 'save-snapshot'); // 2
  ks.transcriptStore.rolloverSpan('v1'); // range= 0..3
  const spanHash1 =
    '57152efdd7fdf75c03371d2b4f1088d5bf3eae7fe643babce527ff81df38998c';

  ks.transcriptStore.addItem('v1', 'load-snapshot'); // 3
  ks.transcriptStore.addItem('v1', 'delivery2'); // 4
  await ks.snapStore.saveSnapshot('v1', 5, getSnapshotStream(snapshotData));
  ks.transcriptStore.addItem('v1', 'save-snapshot'); // 5
  ks.transcriptStore.rolloverSpan('v1'); // range= 3..6
  const spanHash2 =
    '1947001e78e01bd1e773feb22b4ffc530447373b9de9274d5d5fbda3f23dbf2b';

  ks.transcriptStore.addItem('v1', 'load-snapshot'); // 6
  ks.transcriptStore.addItem('v1', 'delivery3'); // 7
  const spanHash3 =
    'e6b42c6a3fb94285a93162f25a9fc0145fd4c5bb144917dc572c50ae2d02ee69';
  // current range= 6..8

  ss1.hostStorage.commit();

  // create an export, and assert that the pieces match what we
  // expect. exportMode='current' means we get all metadata, no
  // historical transcript spans, and no historical snapshots

  assert.typeof(mode, 'string');
  let exportMode = mode;
  if (mode === 'debug-on-pruned') {
    exportMode = 'debug';
  }
  const exporter = makeSwingStoreExporter(dbDir, exportMode);

  // exportData
  {
    const exportData = new Map();
    for await (const [key, value] of exporter.getExportData()) {
      exportData.set(key, value);
    }
    // console.log(exportData);

    const check = (key, expected) => {
      t.true(exportData.has(key));
      let value = exportData.get(key);
      exportData.delete(key);
      if (typeof expected === 'object') {
        value = JSON.parse(value);
      }
      t.deepEqual(value, expected);
    };

    check('kv.key1', 'value1');
    check('snapshot.v1.2', {
      vatID: 'v1',
      snapPos: 2,
      inUse: 0,
      hash: snapHash,
    });
    check('snapshot.v1.5', {
      vatID: 'v1',
      snapPos: 5,
      inUse: 1,
      hash: snapHash,
    });
    check('snapshot.v1.current', 'snapshot.v1.5');
    const base = { vatID: 'v1', incarnation: 0, isCurrent: 0 };
    check('transcript.v1.0', {
      ...base,
      startPos: 0,
      endPos: 3,
      hash: spanHash1,
    });
    check('transcript.v1.3', {
      ...base,
      startPos: 3,
      endPos: 6,
      hash: spanHash2,
    });
    check('transcript.v1.current', {
      ...base,
      startPos: 6,
      endPos: 8,
      isCurrent: 1,
      hash: spanHash3,
    });
    check(`bundle.${bundle0ID}`, bundle0ID);

    // the above list is supposed to be exhaustive
    if (exportData.size) {
      console.log(exportData);
      t.fail('unexpected exportData keys');
    }
  }

  // artifacts
  {
    const names = new Set();
    const contents = new Map();
    for await (const name of exporter.getArtifactNames()) {
      names.add(name);
      contents.set(name, (await buffer(exporter.getArtifact(name))).toString());
    }
    // console.log(contents);

    const check = async (name, expected) => {
      t.true(names.has(name));
      names.delete(name);
      let data = contents.get(name);
      if (typeof expected === 'object') {
        data = JSON.parse(data);
      }
      t.deepEqual(data, expected);
    };

    // export mode 'current' means we omit historical snapshots and
    // transcript spans

    await check('snapshot.v1.5', 'snapshot data');
    await check('transcript.v1.6.8', 'load-snapshot\ndelivery3\n');
    await check(`bundle.${bundle0ID}`, bundle0);

    if (mode === 'archival' || mode === 'debug' || mode === 'debug-on-pruned') {
      // adds the old transcript spans
      await check(
        'transcript.v1.0.3',
        'start-worker\ndelivery1\nsave-snapshot\n',
      );
      await check(
        'transcript.v1.3.6',
        'load-snapshot\ndelivery2\nsave-snapshot\n',
      );
    }

    if (mode === 'debug') {
      // adds the old snapshots, which are only present if
      // initSwingStore() was given {keepSnapshots: true}
      await check('snapshot.v1.2', 'snapshot data');
      // mode='debug-on-pruned' exercises the keepSnapshots:false case
    }

    if (names.size) {
      console.log(names);
      t.fail('unexpected artifacts');
    }
  }
});

test('export current', exportTest, 'current');
test('export archival', exportTest, 'archival');
test('export debug', exportTest, 'debug');
test('export debug-on-pruned', exportTest, 'debug-on-pruned');
