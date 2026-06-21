#!/usr/bin/env node

const capabilityName = process.argv[2]?.trim();

if (capabilityName === undefined || capabilityName.length === 0) {
  process.stderr.write("Capability name is required.\n");
  process.exit(2);
}

process.stderr.write(`${capabilityName} is unavailable in this scaffold.\n`);
process.exit(2);
