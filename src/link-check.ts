import * as core from '@actions/core';
import {crawlLink} from './crawler';

async function run() {
  try {
    let url = core.getInput('url', {required: true});
    const results = await crawlLink(url);
    core.setOutput('results', results);
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
