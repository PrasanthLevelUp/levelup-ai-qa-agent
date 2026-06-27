#!/usr/bin/env ts-node
/**
 * One-off SETUP crawl — builds an Application Profile for saucedemo.com and
 * saves the crawl_data JSON. This is the "crawl your application first" step
 * that must happen BEFORE deterministic healing (which never crawls).
 *
 *   ts-node scripts/crawl-saucedemo-profile.ts /abs/output.json
 */
import * as fs from 'fs';
import * as path from 'path';
import { PageCrawler } from '../src/script-gen/page-crawler';

async function main() {
  const out = path.resolve(process.argv[2] || '/home/ubuntu/saucedemo-app-profile.json');
  const crawler = new PageCrawler({ url: 'https://www.saucedemo.com', maxDepth: 1, captureScreenshot: false });
  console.log('Crawling https://www.saucedemo.com ...');
  const result = await crawler.crawl();
  fs.writeFileSync(out, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`Saved profile → ${out}`);
  console.log(`elements=${result.elements?.length ?? 0} buttons=${result.buttons?.length ?? 0} forms=${result.forms?.length ?? 0}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
