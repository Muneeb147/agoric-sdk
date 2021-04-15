// This file is not very useful as an
// automated test. Rather, its purpose is just to run it to see what a
// deep stack looks like.

// eslint-disable-next-line import/no-extraneous-dependencies
import { test } from '@agoric/swingset-vat/tools/prepare-test-env-ava';

import { E } from './get-hp';

test('deep-stacks when', t => {
  let r;
  const p = new Promise(res => (r = res));
  const q = E.when(p, v1 => E.when(v1 + 1, v2 => assert.equal(v2, 22)));
  r(33);
  return q.catch(reason => {
    t.assert(reason instanceof Error);
    console.log('expected failure', reason);
  });
});

/*
prepare-test-env-ava sets the `"stackFiltering"` option to `lockdown` to
`"verbose"`. For expository purposes, if the `"stackFiltering"` option to
`lockdown` is set to `"concise"` you should see something like the
following. What you should actually see with `"verbose"` is like this, but with
much extraneous information --- infrastructure stack frames and longer file
paths. See
https://github.com/endojs/endo/blob/master/packages/ses/lockdown-options.md

```
$ ava test/test-deep-stacks.js

expected failure (RangeError#1)
RangeError#1: Expected 34 is same as 22
  at packages/eventual-send/test/test-deep-stacks.js:13:57

RangeError#1 ERROR_NOTE: Thrown from: (Error#2) : 2 . 0
RangeError#1 ERROR_NOTE: Rejection from: (Error#3) : 1 . 1
Nested 2 errors under RangeError#1
  Error#2: Event: 1.1
    at packages/eventual-send/test/test-deep-stacks.js:13:31

  Error#2 ERROR_NOTE: Caused by: (Error#3)
  Nested error under Error#2
    Error#3: Event: 0.1
      at packages/eventual-send/test/test-deep-stacks.js:13:15
      at async Promise.all (index 0)
```

If you're in a shell or IDE that supports it, try clicking (or command-clicking
or something) on the file paths for test-deep-stacks.js You should see that there
are three invocations that were spread over three turns.
*/
