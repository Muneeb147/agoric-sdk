#!/bin/bash

# Exit when any command fails
set -e

source /usr/src/upgrade-test-scripts/env_setup.sh

./verifyPushedPrice.js 'ATOM' 12.01
./verifyPushedPrice.js 'stATOM' 12.01
