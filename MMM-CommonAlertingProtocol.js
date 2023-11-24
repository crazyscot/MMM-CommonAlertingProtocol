/* global Module */

/* Magic Mirror
 * Module: MMM-CommonAlertingProtocol
 * Based on NewsFeed by Michael Teeuw.
 *
 * By Ross Younger
 * MIT Licensed.
 */


Module.register("MMM-CommonAlertingProtocol", {
	defaults: {
		/* 
		Recommendation R.2. – Polling Frequency
		MetService recommends the CAP Feed is polled at least every five minutes to ensure timely
receipt of all Warnings and Watches, but not polled more frequently than every two minutes.
		*/
		updateInterval: 300000,
		retryDelay: 5000,
		feeds: [
			{
				title: "MetService",
				url: "https://alerts.metservice.com/cap/rss",
			}
		],
		maxDisplayItems: 0,
		prohibitedWords: [],
		removeStartTags: "",
		removeEndTags: "",
		broadcastAlertUpdates: true,
		showSourceTitle: true,
		showPublishDate: true,
		useCache: false, // Intended for development only

		// TODO location filter for geo-coded alerts
		// TODO high prority only
		// TODO other filter rules?
	},

	requiresVersion: "2.1.0", // Required version of MagicMirror

	start: function() {
		Log.info(`Starting module: ${this.name}`);

		var self = this;
		this.alertItems = [];

		this.loaded = false;
		this.error = null;

		this.registerFeeds();

		// Schedule update timer.
		setInterval(function() {
			self.updateDom();
		}, this.updateInterval);
	},

	getUrlPrefix: function (item) {
		if (item.useCorsProxy) {
			return `${location.protocol}//${location.host}/cors?url=`;
		} else {
			return "";
		}
	},

	getScripts: function() {
		return ["moment.js"];
	},

	getStyles: function () {
		return [
			"MMM-CommonAlertingProtocol.css",
		];
	},

	// Load translations files
	getTranslations: function() {
		return {
			en: "translations/en.json",
		};
	},

	getTemplate: function () {
		return "cap.njk";
	},

	getTemplateData: function () {
		return {
			config: this.config,
			items: this.alertItems,
			loaded: this.loaded,
		};
	},

	registerFeeds: function () {
		for (let feed of this.config.feeds) {
			this.sendSocketNotification("ADD_FEED", {
				feed: feed,
				config: this.config
			});
		}
	},

	socketNotificationReceived: function (notification, payload) {
		if (notification === "FEED_ITEMS") {
			this.generateAlerts(payload);

            if (!this.loaded) {
                if (this.config.hideLoading) {
                    this.show();
                }
				this.updateDom(this.config.animationSpeed);
            }

            this.loaded = true;
            this.error = null;

			// TODO load subordinate data pages - in node_helper!
			this.updateDom(100);
		} else if (notification === "FEED_ERROR") {
			this.error = this.translate(payload.error_type);
			this.updateDom(this.config.animationSpeed);
		}
	},

	/**
	 * Generate an ordered list of items for this configured module.
	 * @param {object} feeds An object with feeds returned by the node helper.
	 */
	generateAlerts: function (feeds) {
		// TODO filter items by lat/lon
		// TODO filter by priority, category
		// TODO is there an expiry date? if not, parser on finish should also broadcastItems().
		let newsItems = [];
		for (let feed in feeds) {
			const feedItems = feeds[feed];
			if (this.subscribedToFeed(feed)) {
				for (let item of feedItems) {
					item.sourceTitle = this.titleForFeed(feed);
					if (!(this.config.ignoreOldItems && Date.now() - new Date(item.pubdate) > this.config.ignoreOlderThan)) {
						newsItems.push(item);
					}
				}
			}
		}
		newsItems.sort(function (a, b) {
			const dateA = new Date(a.pubdate);
			const dateB = new Date(b.pubdate);
			return dateB - dateA;
		});

		if (this.config.maxDisplayItems > 0) {
			newsItems = newsItems.slice(0, this.config.maxDisplayItems);
		}

		if (this.config.prohibitedWords.length > 0) {
			newsItems = newsItems.filter(function (item) {
				for (let word of this.config.prohibitedWords) {
					if (item.title.toLowerCase().indexOf(word.toLowerCase()) > -1) {
						return false;
					}
				}
				return true;
			}, this);
		}
		newsItems.forEach((item) => {
			//Remove selected tags from the beginning of rss feed items (title or description)
			if (this.config.removeStartTags === "title" || this.config.removeStartTags === "both") {
				for (let startTag of this.config.startTags) {
					if (item.title.slice(0, startTag.length) === startTag) {
						item.title = item.title.slice(startTag.length, item.title.length);
					}
				}
			}

			if (this.config.removeStartTags === "description" || this.config.removeStartTags === "both") {
				if (this.isShowingDescription) {
					for (let startTag of this.config.startTags) {
						if (item.description.slice(0, startTag.length) === startTag) {
							item.description = item.description.slice(startTag.length, item.description.length);
						}
					}
				}
			}

			//Remove selected tags from the end of rss feed items (title or description)
			if (this.config.removeEndTags) {
				for (let endTag of this.config.endTags) {
					if (item.title.slice(-endTag.length) === endTag) {
						item.title = item.title.slice(0, -endTag.length);
					}
				}

				if (this.isShowingDescription) {
					for (let endTag of this.config.endTags) {
						if (item.description.slice(-endTag.length) === endTag) {
							item.description = item.description.slice(0, -endTag.length);
						}
					}
				}
			}

			// process publish dates
			item.publishDate = moment(new Date(item.pubdate)).fromNow();
			item.severity = item.detail[0].severity; // Minor, Moderate, Severe

		});

		// get updated news items and broadcast them
		const updatedItems = [];
		newsItems.forEach((value) => {
			if (this.alertItems.findIndex((value1) => value1 === value) === -1) {
				// Add item to updated items list
				updatedItems.push(value);
			}
		});

		// check if updated items exist, if so and if we should broadcast these updates, then lets do so
		if (this.config.broadcastAlertUpdates && updatedItems.length > 0) {
			this.sendNotification("CAP_ALERT_UPDATE", { items: updatedItems });
		}

		this.alertItems = newsItems;
	},

	/**
	 * Returns title for the specific feed url.
	 * @param {string} feedUrl Url of the feed
	 * @returns {string} The title of the feed
	 */
		titleForFeed: function (feedUrl) {
			for (let feed of this.config.feeds) {
				if (feed.url === feedUrl) {
					return feed.title || "";
				}
			}
			return "";
	},

	/**
	 * Check if this module is configured to show this feed.
	 * @param {string} feedUrl Url of the feed to check.
	 * @returns {boolean} True if it is subscribed, false otherwise
	 */
	subscribedToFeed: function (feedUrl) {
		for (let feed of this.config.feeds) {
			if (feed.url === feedUrl) {
				return true;
			}
		}
		return false;
	},
});
