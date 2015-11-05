#!/usr/bin/env bash

if [ -d "./lib" ]; then
  for file in $(find "./lib" -type f -name "*.js"); do
    echo "------------------------------------"
    echo "Running Tests for: ${file}"
    node --debug "${file}"
  done
fi
