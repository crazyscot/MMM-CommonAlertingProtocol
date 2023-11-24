/* 
 * Based on Newsfeed by Michael Teeuw https://michaelteeuw.nl
 * MIT Licensed.
 */

const NodeHelper = require("node_helper");
const Log = require("logger");
const NewsfeedFetcher = require("./newsfeedfetcher");
const xml2js = require("xml2js");
const PiP = require("point-in-polygon");
const lodash = require("lodash");

module.exports = NodeHelper.create({
	// Override start method.
	start: function () {
		Log.log(`Starting node helper for: ${this.name}`);
		this.fetchers = [];
		this.fetch = fetch;
		this.fetchCache = null;
		this.alertDetail = {}; // key: url; value: parsed CAP object
		this.location = null; // will be {lat: Y, lon: X} if configured
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
		if (config.cacheFeed) this.ensureFetchCache();
		if (config.lat && config.lon) {
			this.location = { lat: config.lat, lon: config.lon };
		}

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
			fetcher = new NewsfeedFetcher(url, reloadInterval, encoding, config.logFeedWarnings, useCorsProxy, this.fetchCache);

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
		Promise.all(asyncs)
			.finally(() => { this.filterItems(); })
			.then(() => { this.broadcastFeeds(); });
	},

	/** Applies geo-filtering to the alert items, if configured */
	filterItems: function () {
		if (!this.location) return;
		let latlon = [this.location.lat || 0.0, this.location.lon || 0.0];
		for (let f in this.fetchers) {
			let items = this.fetchers[f].items();
			lodash.remove(items, function (item) {
				// If there are any polygons in the alert detail, then we must be inside at least one of them to pass.
				var seenAny = false;
				for (let detail in item.detail) {
					for (let area in item.detail[detail].area) {
						var poly = item.detail[detail].area[area].polygon;
						if (poly) {
							const parsedPolys = parsePolygons(poly);
							seenAny = true;
							for (let p in parsedPolys) {
								if (PiP(latlon, parsedPolys[p])) {
									return false;
								}
							}
						}
					}
				}
				// But if there are no area detail polygons, let it pass.
				return seenAny;
			});
		}
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

/** Converts area polygon strings into a form that point-in-polygon can handle
 * Input: array of strings
 * Output: array of polygons (as returned by parsePolygon; each is an array of arrays)
 */
function parsePolygons(data) {
	if (data instanceof String) {
		return [parsePolygon(data)];
	}
	return lodash.map(data, parsePolygon);
}

/** Converts an area polygon from string into an array of arrays
 * Input example: "-40.866,174.111 -40.863,174.125 -40.911,174.128 -40.938,174.108"
 * Output: [ [-40.866,174.111], [-40.863,174.125], [-40.911,174.128], [-40.938,174.108] ]
 */
function parsePolygon(data) {
	var str = String(data);
	var points = str.split(" ");
	var output = [];
	for (let i in points) {
		var coords = points[i].split(",");
		var thisPoint = [];
		for (let c in coords) {
			let n = Number(coords[c]);
			if (n !== n) {
				// parsing failed; Number conversion returned NaN
				return null;
			}
			thisPoint.push(n);
		}
		output.push(thisPoint);
	}
	return output;
}