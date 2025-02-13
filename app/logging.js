// NOTE: Temporarily allow `then` until we convert the entire file to `async` / `await`:
/* eslint-disable more/no-then */

const path = require('path');
const fs = require('fs');

const electron = require('electron');
const bunyan = require('bunyan');
const _ = require('lodash');
const readFirstLine = require('firstline');
const readLastLines = require('read-last-lines').read;
const rimraf = require('rimraf');

const { redactAll } = require('../js/modules/privacy');

const { app, ipcMain: ipc } = electron;
const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];
let logger;

module.exports = {
  initialize,
  getLogger,
  fetch,
};

function initialize() {
  if (logger) {
    throw new Error('Already called initialize!');
  }

  const basePath = app.getPath('userData');
  const logPath = path.join(basePath, 'logs');
  fs.mkdirSync(logPath, { recursive: true });

  return cleanupLogs(logPath).then(() => {
    if (logger) {
      return;
    }

    const logFile = path.join(logPath, 'log.log');

    logger = bunyan.createLogger({
      name: 'log',
      streams: [
        {
          level: 'debug',
          stream: process.stdout,
        },
        {
          type: 'rotating-file',
          path: logFile,
          period: '1d',
          count: 3,
        },
      ],
    });

    LEVELS.forEach(level => {
      ipc.on(`log-${level}`, (first, ...rest) => {
        logger[level](...rest);
      });
    });

    ipc.on('fetch-log', event => {
      fs.mkdirSync(logPath, { recursive: true });

      fetch(logPath).then(
        data => {
          event.sender.send('fetched-log', data);
        },
        error => {
          logger.error(`Problem loading log from disk: ${error.stack}`);
        }
      );
    });

    ipc.on('delete-all-logs', async event => {
      try {
        await deleteAllLogs(logPath);
      } catch (error) {
        logger.error(`Problem deleting all logs: ${error.stack}`);
      }

      event.sender.send('delete-all-logs-complete');
    });
  });
}

async function deleteAllLogs(logPath) {
  return new Promise((resolve, reject) => {
    rimraf(
      logPath,
      {
        disableGlob: true,
      },
      error => {
        if (error) {
          return reject(error);
        }

        return resolve();
      }
    );
  });
}

async function cleanupLogs(logPath) {
  const now = new Date();
  const earliestDate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6)
  );

  try {
    const remaining = await eliminateOutOfDateFiles(logPath, earliestDate);
    const files = _.filter(remaining, file => !file.start && file.end);

    if (!files.length) {
      return;
    }

    await eliminateOldEntries(files, earliestDate);
  } catch (error) {
    console.error('Error cleaning logs; deleting and starting over from scratch.', error.stack);

    // delete and re-create the log directory
    await deleteAllLogs(logPath);
    fs.mkdirSync(logPath, { recursive: true });
  }
}

function isLineAfterDate(line, date) {
  if (!line) {
    return false;
  }

  try {
    const data = JSON.parse(line);
    return new Date(data.time).getTime() > date.getTime();
  } catch (e) {
    console.log('error parsing log line', e.stack, line);
    return false;
  }
}

function eliminateOutOfDateFiles(logPath, date) {
  const files = fs.readdirSync(logPath);
  const paths = files.map(file => path.join(logPath, file));

  return Promise.all(
    _.map(paths, target =>
      Promise.all([readFirstLine(target), readLastLines(target, 2)]).then(results => {
        const start = results[0];
        const end = results[1].split('\n');

        const file = {
          path: target,
          start: isLineAfterDate(start, date),
          end:
            isLineAfterDate(end[end.length - 1], date) ||
            isLineAfterDate(end[end.length - 2], date),
        };

        if (!file.start && !file.end) {
          fs.unlinkSync(file.path);
        }

        return file;
      })
    )
  );
}

function eliminateOldEntries(files, date) {
  const earliest = date.getTime();

  return Promise.all(
    _.map(files, file =>
      fetchLog(file.path).then(lines => {
        const recent = _.filter(lines, line => new Date(line.time).getTime() >= earliest);
        const text = _.map(recent, line => JSON.stringify(line)).join('\n');

        return fs.writeFileSync(file.path, `${text}\n`);
      })
    )
  );
}

function getLogger() {
  if (!logger) {
    throw new Error("Logger hasn't been initialized yet!");
  }

  return logger;
}

function fetchLog(logFile) {
  return new Promise((resolve, reject) => {
    fs.readFile(logFile, { encoding: 'utf8' }, (err, text) => {
      if (err) {
        return reject(err);
      }

      const lines = _.compact(text.split('\n'));
      const data = _.compact(
        lines.map(line => {
          try {
            return _.pick(JSON.parse(line), ['level', 'time', 'msg']);
          } catch (e) {
            return null;
          }
        })
      );

      return resolve(data);
    });
  });
}

function fetch(logPath) {
  // Check that the file exists locally
  if (!fs.existsSync(logPath)) {
    console._log('Log folder not found while fetching its content. Quick! Creating it.');
    fs.mkdirSync(logPath, { recursive: true });
  }
  const files = fs.readdirSync(logPath);
  const paths = files.map(file => path.join(logPath, file));

  // creating a manual log entry for the final log result
  const now = new Date();
  const fileListEntry = {
    level: 30, // INFO
    time: now.toJSON(),
    msg: `Loaded this list of log files from logPath: ${files.join(', ')}`,
  };

  return Promise.all(paths.map(fetchLog)).then(results => {
    const data = _.flatten(results);

    data.push(fileListEntry);

    return _.sortBy(data, 'time');
  });
}

function logAtLevel(level, ...args) {
  if (logger) {
    // To avoid [Object object] in our log since console.log handles non-strings smoothly
    const str = args.map(item => {
      if (typeof item !== 'string') {
        try {
          return JSON.stringify(item);
        } catch (e) {
          return item;
        }
      }

      return item;
    });
    logger[level](redactAll(str.join(' ')));
  } else {
    console._log(...args);
  }
}

// This blows up using mocha --watch, so we ensure it is run just once
if (!console._log) {
  console._log = console.log;
  console.log = _.partial(logAtLevel, 'info');
  console._error = console.error;
  console.error = _.partial(logAtLevel, 'error');
  console._warn = console.warn;
  console.warn = _.partial(logAtLevel, 'warn');
}
