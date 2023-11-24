/* 
 * Based on Newsfeed by Michael Teeuw https://michaelteeuw.nl
 * MIT Licensed.
 */

const NodeHelper = require("node_helper");
const Log = require("logger");
const NewsfeedFetcher = require("./newsfeedfetcher");
const xml2js = require("xml2js");

module.exports = NodeHelper.create({
	// Override start method.
	start: function () {
		Log.log(`Starting node helper for: ${this.name}`);
		this.fetchers = [];
		this.fetch = fetch;
		this.fetchCache = null;
		this.alertDetail = {}; // key: url; value: parsed CAP object
	},

	// Override socketNotificationReceived received.
	socketNotificationReceived: function (notification, payload) {
		if (notification === "ADD_FEED") {
			this.createFetcher(payload.feed, payload.config);
		}
	},

	ensureFetchCache: function () {
		if (!this.fetchCache) {
			let builder = require('node-fetch-cache').fetchBuilder;
			let fscache = require('node-fetch-cache').FileSystemCache;
			const options = {
				// cacheDirectory: '/some/path', // defaults to .cache
				ttl: 86400000, // ms
			};
			this.fetchCache = builder.withCache(new fscache(options));
			this.fetch = this.fetchCache;
		}
	},

	/**
	 * Creates a fetcher for a new feed if it doesn't exist yet.
	 * Otherwise it reuses the existing one.
	 * @param {object} feed The feed object
	 * @param {object} config The configuration object
	 */
	createFetcher: function (feed, config) {
		const url = feed.url || "";
		const encoding = feed.encoding || "UTF-8";
		const reloadInterval = feed.reloadInterval || config.reloadInterval || 5 * 60 * 1000;
		let useCorsProxy = feed.useCorsProxy;
		if (useCorsProxy === undefined) useCorsProxy = true;
		if (config.useCache) this.ensureFetchCache();

		try {
			new URL(url);
		} catch (error) {
			Log.error("CAP feed Error. Malformed feed url: ", url, error);
			this.sendSocketNotification("FEED_ERROR", { error_type: "MODULE_ERROR_MALFORMED_URL" });
			return;
		}

		let fetcher;
		if (typeof this.fetchers[url] === "undefined") {
			Log.log(`Create new newsfetcher for url: ${url} - Interval: ${reloadInterval}`);
			fetcher = new NewsfeedFetcher(url, reloadInterval, encoding, config.logFeedWarnings, useCorsProxy);

			fetcher.onReceive(() => {
				this.processAlerts();
			});

			fetcher.onError((fetcher, error) => {
				Log.error("CAP feed Error. Could not fetch feed: ", url, error);
				let error_type = NodeHelper.checkFetchError(error);
				this.sendSocketNotification("FEED_ERROR", {
					error_type
				});
			});

			this.fetchers[url] = fetcher;
		} else {
			Log.log(`Use existing newsfetcher for url: ${url}`);
			fetcher = this.fetchers[url];
			fetcher.setReloadInterval(reloadInterval);
			fetcher.broadcastItems();
		}

		fetcher.startFetch();
	},

	/**
	 * Ensure we've got the data for all active items in all feeds, then broadcast them
	 */
	processAlerts: function () {
		let asyncs = [];
		// Grab all alert detail
		for (let f in this.fetchers) {
			let items = this.fetchers[f].items();
			for (let i in items) {
				let alert = items[i];
				if (alert.url !== undefined && alert.detail === undefined) {
					Log.log(`Retrieving alert detail for ${alert.url}`);
					alert.detail = [];
					asyncs.push(
						this.fetch(alert.url)
							.then(NodeHelper.checkFetchStatus)
							.then((response) => response.text())
							.then((text) => xml2js.parseStringPromise(text))
							.then((result) => { 
								let detail = result?.alert?.info || [];
								alert.detail.push(...detail);
								return alert;
							})
							.catch((error) => { 
								Log.error("CAP feed Error. Could not fetch detail: ", alert.url, error);
								let error_type = NodeHelper.checkFetchError(error);
								this.sendSocketNotification("FEED_ERROR", {
									error_type
								});
							})
					);
				}
			}
		}
		Log.log("asyncs " + asyncs.length);
		Promise.all(asyncs).finally(() => {
			this.broadcastFeeds();
		});
	},

	/**
	 * Creates an object with all feed items of the different registered feeds,
	 * and broadcasts these using sendSocketNotification.
	 */
	broadcastFeeds: function () {
		const feeds = {};
		for (let f in this.fetchers) {
			feeds[f] = this.fetchers[f].items();
		}
		Log.debug(`CAP: Sending alerts for ${Object.keys(feeds).length} feeds`);
		this.sendSocketNotification("FEED_ITEMS", feeds);
	}
});
