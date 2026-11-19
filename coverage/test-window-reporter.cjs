/**
 * Playwright reporter (trial). It writes the start and end time of each test,
 * so the coverage requests can be matched to tests by time.
 *
 * Use it with: --reporter=list,/path/to/test-window-reporter.cjs
 */
const fs = require('fs');
const path = require('path');

const OUT = path.resolve(__dirname, '../coverage-data/test-windows.json');
// Progress for the app's sync job: tests done of all tests, and the test that runs now.
const PROGRESS = path.resolve(__dirname, '../coverage-data/progress.json');

class TestWindowReporter {
  constructor() {
    this.windows = [];
    this.open = new Map();
    this.progress = { total: 0, done: 0, failed: 0, current: '' };
  }

  writeProgress() {
    try {
      fs.mkdirSync(path.dirname(PROGRESS), { recursive: true });
      fs.writeFileSync(PROGRESS, JSON.stringify({ ...this.progress, at: Date.now() / 1000 }));
    } catch {
      /* progress is only for the app */
    }
  }

  onBegin(config, suite) {
    this.progress.total = suite.allTests().length;
    this.writeProgress();
  }

  onTestBegin(test, result) {
    this.open.set(test.id + ':' + result.retry, Date.now() / 1000);
    this.progress.current = test.titlePath().slice(3).filter(Boolean).join(' > ');
    this.writeProgress();
  }

  onTestEnd(test, result) {
    const key = test.id + ':' + result.retry;
    this.windows.push({
      id: test.id,
      title: test.titlePath().filter(Boolean).join(' > '),
      // titlePath() is [root, project, file, ...describes, title]. Keep the parts
      // after the project as a list, so titles that contain " > " stay intact.
      project: test.parent.project()?.name ?? '',
      path: test.titlePath().slice(2),
      file: path.relative(process.cwd(), test.location.file),
      line: test.location.line,
      tags: test.tags,
      retry: result.retry,
      status: result.status,
      start: this.open.get(key),
      end: Date.now() / 1000,
    });
    this.open.delete(key);
    // A retry runs the same test again: count the test when its last try ends.
    if (result.status === 'passed' || result.status === 'skipped' || result.retry >= test.retries) {
      this.progress.done++;
      if (result.status !== 'passed' && result.status !== 'skipped') this.progress.failed++;
    }
    this.writeProgress();
  }

  onEnd() {
    // Tests that never started (their setup failed) get no onTestEnd. The run is over, so show it as done.
    this.progress.done = this.progress.total;
    this.progress.current = '';
    this.writeProgress();
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(this.windows, null, 2));
  }
}

module.exports = TestWindowReporter;
