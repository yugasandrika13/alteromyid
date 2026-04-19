const args = process.argv.slice(2);
const has = f => args.includes(f);
const log = m => process.stdout.write(m + '\n');

if (has('--validate-only')) {
  log('validate:installer skipped');
  process.exit(0);
}

if (has('--watch')) {
  log('sync:installer watch mode is disabled');
  process.exit(0);
}

if (has('--daemon')) {
  log('sync:installer daemon start skipped');
  process.exit(0);
}

if (has('--stop')) {
  log('sync:installer daemon stop skipped');
  process.exit(0);
}

if (has('--status')) {
  log('sync:installer daemon status: disabled');
  process.exit(0);
}

log('sync:installer no-op');
process.exit(0);

