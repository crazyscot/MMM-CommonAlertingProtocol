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
				config: {
					// You can override settings in commonConfig on a per-feed basis.
				},
			}
		],
		maxDisplayItems: 0,
		prohibitedWords: [],
		removeStartTags: "",
		removeEndTags: "",
		broadcastAlertUpdates: true,
		commonConfig: {
			showSourceTitle: true,
			showPublishDate: true,
			showAreaDescription: true,
			showIcon: true,
			showAlertTitle: true,
			showOnset: true,
		},
		cacheFeed: false, // Intended for development only
		lat: null, // Geo-filter location
		lon: null, // Geo-filter location
	},

	requiresVersion: "2.1.0", // Required version of MagicMirror

	start: function() {
		Log.info(`Starting module: ${this.name}`);

		var self = this;
		this.alertItems = [];

		this.loaded = false;
		this.error = null;

		this.registerFeeds();
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
		return ["font-awesome.css", "weather-icons.css", "MMM-CommonAlertingProtocol.css"];
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

			this.updateDom(100);
		} else if (notification === "FEED_ERROR") {
			this.error = this.translate(payload.error_type);
			this.updateDom(this.config.animationSpeed);
		}
	},

	/** Map MetService event types into WI icons */
	convertEventType: function (event) {
		let s = String(event);
		switch (s) {
			case "wind":
				return "strong-wind";
			default:
				return s;
		}
	},

	/**
	 * Generate a merged config block for a feed
	 * @note If multiple feeds are configured with the same URL, the results may be surprising.
	 * The helper assumes feed URLs are unique.
	 */
	configForFeed: function (url) {
		for (let iter in this.config.feeds) {
			const feed = this.config.feeds[iter];
			if (feed.url === url) {
				return { ...this.defaults.commonConfig, ... this.config.commonConfig, ...feed.config };
			}
		}
		console.log(`Missing feed config?! ${url}`);
		return { ...this.defaults.commonConfig, ... this.config.commonConfig };
	},

	/**
	 * Generate an ordered list of items for this configured module.
	 * @param {object} feeds An object with feeds returned by the node helper.
	 */
	generateAlerts: function (feeds) {
		let newsItems = [];
		for (let feed in feeds) {
			const feedItems = feeds[feed];
			const thisFeedConfig = this.configForFeed(feed);
			if (this.subscribedToFeed(feed)) {
				for (let item of feedItems) {
					item.sourceTitle = this.titleForFeed(feed);
					item.config = thisFeedConfig;
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

			// process data we want to directly report
			item.publishDate = moment(new Date(item.pubdate)).fromNow();
			item.severity = item.detail[0]?.severity; // Minor, Moderate, Severe
			item.iconClass = this.convertEventType(item.detail[0]?.event);
			var areas = [];
			item.detail.forEach((detail) => {
				detail.area.forEach((area) => {
					if (area.areaDesc)
						areas.push(area.areaDesc);
				});
			});
			item.areas = areas.join(", ");
			let onset = item.detail[0]?.onset;
			if (onset) {
				item.onset = moment(new Date(onset)).calendar();
			}
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

