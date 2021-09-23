/**
 * wget-r
 */

import axios from "axios";
import * as cheerio from "cheerio";
import {promises as fs} from "fs";
import {URL} from "url";
import {fromXML} from "from-xml";
import {toXML} from "to-xml";

import type {wgetr} from "..";

const defaults: wgetr.Options = {
    // logger: console,
    logger: {log: through},

    fetcher: axios,

    mkdir: fs,

    writer: fs,
};

function pathFilter(path: string) {
    path = decodeURIComponent(path);
    return path
        .replace(/^([\w\-]+\:)?\/\/[^\/]+\//, "")
        .replace(/[\?\#].*$/, "")
        .replace(/\/[^\/]+?(\.html?)?$/i, (match, ext) => (ext ? match : match + "/"))
        .replace(/\/$/, "/index.html");
}

function sitemapFilter(item: SitemapItem): SitemapItem {
    const {loc, lastmod, priority} = item;
    return {loc, lastmod, priority};
}

export function wgetR(config?: wgetr.Options) {
    return new WgetR(config);
}

class WgetR implements wgetr.WgetR {
    protected config: wgetr.Options;
    protected items: Item[] = [];
    protected stored: { [url: string]: boolean } = {};

    constructor(config?: wgetr.Options) {
        this.config = config || {} as wgetr.Options;
    }

    /**
     * Add page items from remote sitemap.xml
     */

    async addSitemap(url: string): Promise<void> {
        this.log("reading sitemap: " + url);
        let data: string | Buffer;

        const fetcher = this.config.fetcher || defaults.fetcher;
        try {
            const res = await fetcher.get(url);
            data = res.data;
        } catch (e) {
            this.log("fetcher: " + e + " " + url);
            return;
        }

        const sitemap = fromXML("string" === typeof data ? data : String(data));

        const sitemapList = getItemList(sitemap.sitemapindex?.sitemap);
        if (sitemapList?.length) {
            for (const item of sitemapList) {
                await this.addSitemap(item.loc);
            }
        }

        const urlList = getItemList(sitemap.urlset?.url);
        if (urlList?.length) {
            urlList.forEach(item => this.addSitemapItem(item));
        }
    }

    /**
     * Add a single page item by URL
     */

    addPage(url: string): void {
        this.addSitemapItem({loc: url});
    }

    private addSitemapItem(item: SitemapItem): void {
        let {loc} = item;

        // test pathname is allowed
        const url = new URL(loc);
        const {include} = this.config;
        if (include && !include.test(url.pathname)) return;

        // skip when another file stored
        const path = pathFilter(loc);
        if (this.stored[path]) return;
        this.stored[path] = true;

        // add item
        this.items.push(new Item(item, this.config));
    }

    /**
     * Run loop for each page
     */

    async forEach(fn: (item: Item, idx?: number, array?: Item[]) => void): Promise<void> {
        let idx = 0;
        const {items} = this;
        for (const item of items) {
            await fn(item, idx++, items);
        }
    }

    getTotalItems(): number {
        return this.items.length;
    }

    async writePagesTo(prefix: string): Promise<void> {
        const check = {} as { [url: string]: boolean };

        await this.forEach(async item => {
            const path = await item.getPath();
            if (check[path]) return;
            check[path] = true;
            await item.writePageTo(prefix);
        });
    }

    /**
     * Generate sitemap.xml
     */

    async getSitemapXML(): Promise<string> {
        const data = {'?': 'xml version="1.0" encoding="utf-8"'} as any;
        const urlset = data.urlset = {"@xmlns": "http://www.sitemaps.org/schemas/sitemap/0.9"} as any;
        const list = urlset.url = [] as SitemapItem[];

        await this.forEach(async item => {
            const row = await item.getSitemapItem();
            list.push(row);
        });

        return toXML(data, null, 1);
    }

    /**
     * Write sitemap.xml file to local
     */

    async writeSitemapTo(path: string): Promise<void> {
        const xml = await this.getSitemapXML();

        this.log("writing sitemap: " + path);

        const mkdir = this.config.mkdir || defaults.mkdir;
        const dir = path.replace(/[^\/]+$/, "");
        await mkdir.mkdir(dir, {recursive: true});

        const writer = this.config.writer || defaults.writer;
        await writer.writeFile(path, xml);
    }

    /**
     * Crawl
     */

    async crawlAll(): Promise<void> {
        const check = {} as { [url: string]: boolean };
        let loop = 1;

        while (1) {
            const prev = this.getTotalItems();
            const buf = [] as string[];

            await this.forEach(async item => {
                const path = await item.getPath();
                if (check[path]) return;
                check[path] = true;

                const links = await item.getLinks(true);
                // this.log("links: " + links.length + " (" + (idx + 1) + "/" + items.length + ")");
                if (!links) return;

                buf.push.apply(buf, links);
            });

            buf.forEach(url => this.addPage(url));

            const total = this.getTotalItems();
            const found = total - prev;
            this.log("crawl: #" + loop + " " + found + " found");
            loop++;
            if (!found) break;
        }
    }

    protected log(message: string): void {
        const logger = this.config.logger || defaults.logger;
        logger.log(message);
    }
}

class SitemapItem implements wgetr.SitemapItem {
    loc: string;
    priority?: string;
    lastmod?: string;
}

class ItermRaw implements wgetr.ItemRaw {
    constructor(protected item: SitemapItem, protected config: wgetr.Options) {
        //
    }

    /**
     * Get sitemap item
     */

    async getSitemapItem(): Promise<SitemapItem> {
        return sitemapFilter(this.item);
    }

    /**
     * Fetch HTML source from server
     */

    async getContent(): Promise<string | Buffer> {
        let url = this.item.loc;

        this.log("reading: " + url);

        const fetcher = this.config.fetcher || defaults.fetcher;
        try {
            const res = await fetcher.get(url);
            const {data} = res;
            return data;
        } catch (e) {
            this.log("fetcher: " + e + " " + url);
            return;
        }
    }

    /**
     * Fetch HTML page from server and write to local
     */

    async writePageTo(prefix: string): Promise<void> {
        const content = await this.getContent();
        const path = prefix + await this.getPath();

        this.log("writing: " + path);

        const mkdir = this.config.mkdir || defaults.mkdir;
        const dir = path.replace(/[^\/]+$/, "");
        await mkdir.mkdir(dir, {recursive: true});

        const writer = this.config.writer || defaults.writer;
        await writer.writeFile(path, content);
    }

    async getPath(): Promise<string> {
        return pathFilter(this.item.loc);
    }

    /**
     * list of URLs linked by the page.
     */

    async getLinks(sameHost?: boolean): Promise<string[]> {
        const base = new URL(this.item.loc);
        const content = await this.getContent();
        const links = [] as string[];
        if (!content) return;

        let $: cheerio.CheerioAPI;
        try {
            $ = cheerio.load(content);
        } catch (e) {
            this.log("cheerio: " + e);
            return;
        }

        const check = {} as { [href: string]: boolean };
        $("a").each((_idx, a) => {
            const href = $(a).attr("href");
            if (!href) return;
            const urlObj = new URL(href, base);
            if (sameHost && base.hostname !== urlObj.hostname) return;
            const url = urlObj.toString().replace(/#.*$/, "");
            const path = pathFilter(url);
            if (check[path]) return;
            links.push(url);
            check[path] = true;
        });

        return links;
    }

    protected log(message: string): void {
        const logger = this.config.logger || defaults.logger;
        logger.log(message);
    }
}

/**
 * cached content
 */

class Item extends ItermRaw implements wgetr.Item {
    private _content: Promise<string | Buffer>;

    async getContent(): Promise<string | Buffer> {
        return this._content || (this._content = super.getContent());
    }
}

/**
 * @private
 */

function getItemList(list: SitemapItem | SitemapItem[]): SitemapItem[] {
    const item = list as SitemapItem;
    if ("string" === typeof item?.loc) return [item];
    return list as SitemapItem[];
}

function through(input: any) {
    return input;
}