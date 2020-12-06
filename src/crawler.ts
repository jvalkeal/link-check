import * as linkinator from 'linkinator';

export interface Link {
  url: string;
  status: number;
  parent: string;
}

export interface CrawlResult {
  status: boolean;
  brokenLinks: Link[];
}

export async function crawlLink(url: string): Promise<CrawlResult> {
  const checker = new linkinator.LinkChecker();

  // checker.on('pagestart', url => {
  //   console.log(`Scanning ${url}`);
  // });

  // checker.on('link', result => {
  //   console.log(`  ${result.url}`);
  //   console.log(`  ${result.state}`);
  //   console.log(`  ${result.status}`);
  // });

  const result = await checker.check({
    path: url
  });

  console.log(result.passed ? 'PASSED :D' : 'FAILED :(');
  console.log(`Scanned total of ${result.links.length} links!`);
  const brokeLinks = result.links.filter(x => x.state === 'BROKEN');
  console.log(`Detected ${brokeLinks.length} broken links.`);

  const brokenLinks = result.links
    .filter(x => x.state === 'BROKEN')
    .map<Link>(r => {
      return {
        url: r.url,
        status: r.status || 0,
        parent: r.parent || ''
      };
    });

  return {
    status: result.passed,
    brokenLinks
  };
}
