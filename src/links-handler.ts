import * as core from '@actions/core';
import * as handler from './crawl-handler';
import {inspect} from 'util';

export interface Link {
  url: string;
  status: number;
  parent: string;
}

export interface HandlerResult {
  status: boolean;
  brokenLinks: Link[];
}

export async function handle(
  url: string | undefined,
  config: string
): Promise<HandlerResult> {
  const checker = new handler.LinkChecker();
  const options = getLinkinatorOptionsFromJson(config);
  core.debug(`url ${url}`);
  core.debug(`config ${config}`);
  core.debug(`options incoming ${inspect(options)}`);
  if (url) {
    options.paths = [url];
  }
  core.debug(`Linkinator options used ${inspect(options)}`);

  checker.on('pagestart', url => {
    core.info(`Scanning ${url}`);
  });

  checker.on('link', result => {
    if (result.state === 'BROKEN') {
      core.info(`[${result.status}] ${result.url}`);
    }
  });

  checker.on('state', (state: handler.CrawlState) => {
    core.info(
      `State checkedTotal:${state.checkedTotal} mainQueueSize:${state.mainQueueSize} throttleQueueSize:${state.throttleQueueSize}`
    );
  });

  const result = await checker.check(options);

  core.info(result.passed ? 'PASSED :D' : 'FAILED :(');
  core.info(`Scanned total of ${result.links.length} links!`);
  const brokeLinks = result.links.filter(x => x.state === 'BROKEN');
  core.info(`Detected ${brokeLinks.length} broken links.`);

  const brokenLinks = result.links
    // .filter(x => x.state === 'BROKEN')
    .filter(x => x.state === 'BROKEN')
    .filter(x => (x.status !== undefined ? x.status > 0 : true))
    .map<Link>(r => {
      return {
        url: r.url,
        status: r.status || 0,
        parent: r.parent || ''
      };
    });

  const ret: HandlerResult = {
    status: true,
    brokenLinks
  };
  core.debug(`HandlerResult: ${inspect(ret)}`);
  return ret;
}

function getLinkinatorOptionsFromJson(json: string): handler.CheckOptions {
  const jsonConfig: handler.CheckOptions = JSON.parse(json);
  core.debug(`Linkinator JSON config: ${inspect(jsonConfig)}`);
  return jsonConfig;
}
