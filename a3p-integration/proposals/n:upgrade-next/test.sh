#!/bin/bash

# Place here any test that should be executed using the executed proposal.
# The effects of this step are not persisted in further proposal layers.

# suppress file names from glob that run earlier
GLOBIGNORE=initial.test.js

yarn ava ./replaceElectorate.test.js

# test the state right after upgrade
yarn ava initial.test.js

# test more, in ways that change system state
yarn ava ./*.test.js
