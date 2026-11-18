/**
 * Playwright reporter (trial). It writes the start and end time of each test,
 * so the coverage requests can be matched to tests by time.
 *
 * Use it with: --reporter=list,/path/to/test-window-reporter.cjs
 */
const fs = require('fs');
const path = require('path');

const OUT = path.resolve(__dirname, '../coverage-data/test-windows.json');

class TestWindowReporter {
  constructor() {
    this.windows = [];
    this.open = new Map();
  }

  onTestBegin(test, result) {
    this.open.set(test.id + ':' + result.retry, Date.now() / 1000);
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
  }

  onEnd() {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(this.windows, null, 2));
  }
}

module.exports = TestWindowReporter;
