// The services log every request; keep test output readable unless asked.
// lomod's own log for each test file lands in integration/.artifacts/.
if (!process.env.LOMO_IT_VERBOSE) {
  for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
    jest.spyOn(console, level).mockImplementation(() => {});
  }
}
