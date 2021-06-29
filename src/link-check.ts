import * as core from '@actions/core';
import {handle, HandlerResult} from './links-handler';

async function run() {
  const fail = inputNotRequired('fail') === 'false' ? false : true;

  // default output when links handling fails
  let results: HandlerResult = {
    status: false,
    brokenLinks: []
  };

  try {
    const config = inputNotRequired('config');
    const url = inputNotRequired('url');
    core.startGroup('Link check');
    results = await handle(url, config);
    core.setOutput('results', results);
  } catch (error) {
    core.setFailed(error.message);
  } finally {
    core.endGroup();
    core.setOutput('results', results);

    // we fails step if instructed and links check reported failure
    if (fail && results.status) {
      core.setFailed('Found broken links');
    }
  }
}

function inputNotRequired(id: string): string {
  return core.getInput(id, {required: false});
}

run();
