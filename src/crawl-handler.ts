import {EventEmitter} from 'events';
import PQueue, {DefaultAddOptions} from 'p-queue';
import PriorityQueue from 'p-queue/dist/priority-queue';
import * as gaxios from 'gaxios';
import {getLinks} from './links';
import {URL} from 'url';

export interface CheckOptions {
  concurrency?: number;
  port?: number;
  paths: string[];
  recurse?: boolean;
  timeout?: number;
  skip?: string[];
  throttle?: string[];
  throttlelimit?: number;
  throttleinterval?: number;
}

export enum LinkState {
  OK = 'OK',
  BROKEN = 'BROKEN',
  SKIPPED = 'SKIPPED'
}

export interface LinkResult {
  url: string;
  status?: number;
  state: LinkState;
  parent?: string;
}

export interface LinkResults {
  passed: boolean;
  links: LinkResult[];
}

interface CrawlOptions {
  url: URL;
  parent?: string;
  crawl: boolean;
  results: LinkResult[];
  cache: Set<string>;
  checkOptions: CheckOptions;
  queue: PQueue<PriorityQueue, DefaultAddOptions>;
  tqueue: PQueue<PriorityQueue, DefaultAddOptions>;
  rootPath: string;
}

export interface CrawlState {
  checkedTotal: number;
  mainQueueSize: number;
  throttleQueueSize: number;
}

export class LinkChecker extends EventEmitter {
  private next = new Date().getTime() + 10000;

  async check(opts: CheckOptions) {
    const options = await this.processOptions(opts);
    // if (!Array.isArray(options.path)) {
    //   options.path = [options.path];
    // }
    options.skip = options.skip || [];

    const queue = new PQueue({
      concurrency: options.concurrency || 100
    });
    const tqueue = new PQueue({
      concurrency: options.concurrency || 100,
      interval: opts.throttleinterval || 0,
      intervalCap: opts.throttlelimit || 1,
      carryoverConcurrencyCount: true
    });

    const results = new Array<LinkResult>();
    const initCache: Set<string> = new Set();

    for (const path of options.paths) {
      const url = new URL(path);
      initCache.add(url.href);
      queue.add(async () => {
        await this.crawl({
          url,
          crawl: true,
          checkOptions: options,
          results,
          cache: initCache,
          queue,
          tqueue,
          rootPath: path
        });
      });
    }
    await queue.onIdle();
    await tqueue.onIdle();

    const result = {
      links: results,
      passed: results.filter(x => x.state === LinkState.BROKEN).length === 0
    };

    return result;
  }

  async crawl(opts: CrawlOptions): Promise<void> {
    // explicitly skip non-http[s] links before making the request
    const proto = opts.url.protocol;
    if (proto !== 'http:' && proto !== 'https:') {
      const r: LinkResult = {
        url: opts.url.href,
        status: 0,
        state: LinkState.SKIPPED,
        parent: opts.parent
      };
      opts.results.push(r);
      // this.emit('link', r);
      this.emitLink(r, opts);
      return;
    }

    // Check for a user-configured array of link regular expressions that should be skipped
    if (opts.checkOptions.skip) {
      const skips = opts.checkOptions.skip
        .map(linkToSkip => {
          return new RegExp(linkToSkip).test(opts.url.href);
        })
        .filter(match => !!match);

      if (skips.length > 0) {
        const result: LinkResult = {
          url: opts.url.href,
          state: LinkState.SKIPPED,
          parent: opts.parent
        };
        opts.results.push(result);
        // this.emit('link', result);
        this.emitLink(result, opts);
        return;
      }
    }

    // Perform a HEAD or GET request based on the need to crawl
    let status = 0;
    let state = LinkState.BROKEN;
    let data = '';
    let shouldRecurse = false;
    let res: gaxios.GaxiosResponse<string> | undefined = undefined;
    try {
      res = await gaxios.request<string>({
        method: opts.crawl ? 'GET' : 'HEAD',
        url: opts.url.href,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.117 Safari/537.36'
        },
        responseType: opts.crawl ? 'text' : 'stream',
        validateStatus: () => true,
        timeout: opts.checkOptions.timeout
      });

      // If we got an HTTP 405, the server may not like HEAD. GET instead!
      if (res.status === 405) {
        res = await gaxios.request<string>({
          method: 'GET',
          url: opts.url.href,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.117 Safari/537.36'
          },
          responseType: 'stream',
          validateStatus: () => true,
          timeout: opts.checkOptions.timeout
        });
      }
    } catch (err) {
      if (err.type === 'request-timeout') {
        status = -1;
      }
      // request failure: invalid domain name, etc.
      // this also occasionally catches too many redirects, but is still valid (e.g. https://www.ebay.com)
      // for this reason, we also try doing a GET below to see if the link is valid
    }

    try {
      //some sites don't respond to a stream response type correctly, especially with a HEAD. Try a GET with a text response type
      if (
        (res === undefined || res.status < 200 || res.status >= 300) &&
        !opts.crawl
      ) {
        res = await gaxios.request<string>({
          method: 'GET',
          url: opts.url.href,
          responseType: 'text',
          validateStatus: () => true,
          timeout: opts.checkOptions.timeout
        });
      }
    } catch (ex) {
      if (ex.type === 'request-timeout') {
        status = -1;
      }
      // catch the next failure
    }

    if (res !== undefined) {
      status = res.status;
      data = res.data;
      shouldRecurse = isHtml(res);
    }

    // Assume any 2xx status is 👌
    if (status >= 200 && status < 300) {
      state = LinkState.OK;
    }

    const result: LinkResult = {
      url: opts.url.href,
      status,
      state,
      parent: opts.parent
    };
    opts.results.push(result);
    // this.emit('link', result);
    this.emitLink(result, opts);

    // If we need to go deeper, scan the next level of depth for links and crawl
    if (opts.crawl && shouldRecurse) {
      this.emit('pagestart', opts.url);
      const urlResults = getLinks(data, opts.url.href);
      for (const result of urlResults) {
        // if there was some sort of problem parsing the link while
        // creating a new URL obj, treat it as a broken link.
        if (!result.url) {
          const r: LinkResult = {
            url: result.link,
            status: 0,
            state: LinkState.BROKEN,
            parent: opts.url.href
          };
          opts.results.push(r);
          // this.emit('link', r);
          this.emitLink(r, opts);
          continue;
        }

        let crawl = (opts.checkOptions.recurse! &&
          result.url?.href.startsWith(opts.rootPath)) as boolean;

        // only crawl links that start with the same host
        if (crawl) {
          try {
            const pathUrl = new URL(opts.rootPath);
            crawl = result.url!.host === pathUrl.host;
          } catch {
            // ignore errors
          }
        }

        // Ensure the url hasn't already been touched, largely to avoid a
        // very large queue length and runaway memory consumption
        if (!opts.cache.has(result.url.href)) {
          opts.cache.add(result.url.href);

          let throttle = false;
          if (opts.checkOptions.throttle) {
            throttle = opts.checkOptions.throttle.some(element => {
              if (result.url?.href) {
                return new RegExp(element).test(result.url.href);
              }
              return false;
            });
          }

          const crawlJob = async () => {
            await this.crawl({
              url: result.url!,
              crawl,
              cache: opts.cache,
              results: opts.results,
              checkOptions: opts.checkOptions,
              queue: opts.queue,
              tqueue: opts.tqueue,
              parent: opts.url.href,
              rootPath: opts.rootPath
            });
          };

          if (throttle) {
            opts.tqueue.add(crawlJob);
          } else {
            opts.queue.add(crawlJob);
          }
        }
      }
    }
  }

  private emitLink(result: LinkResult, options: CrawlOptions): void {
    this.emit('link', result);
    const now = new Date().getTime();
    if (now > this.next) {
      this.next = new Date().getTime() + 10000;
      const crawlState: CrawlState = {
        checkedTotal: options.results.length,
        mainQueueSize: options.queue.size,
        throttleQueueSize: options.tqueue.size
      };
      this.emit('state', crawlState);
    }
  }

  private async processOptions(opts: CheckOptions): Promise<CheckOptions> {
    const options = Object.assign({}, opts);

    // ensure at least one path is provided
    if (options.paths.length === 0) {
      throw new Error('At least one path must be provided');
    }

    // normalize options.path to an array of strings
    // if (!Array.isArray(options.path)) {
    //   options.path = [options.path];
    // }
    return options;
  }
}

export async function check(options: CheckOptions) {
  const checker = new LinkChecker();
  const results = await checker.check(options);
  return results;
}

function isHtml(response: gaxios.GaxiosResponse): boolean {
  const contentType = response.headers['content-type'] || '';
  return (
    !!contentType.match(/text\/html/g) ||
    !!contentType.match(/application\/xhtml\+xml/g)
  );
}
