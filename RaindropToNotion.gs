// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // API Keys - REPLACE THESE WITH YOUR ACTUAL KEYS
  RAINDROP_API_TOKEN: 'YOUR_RAINDROP_API_TOKEN_HERE',
  NOTION_API_TOKEN: 'YOUR_NOTION_API_TOKEN_HERE',
  NOTION_DATABASE_ID: 'YOUR_NOTION_DATABASE_ID_HERE',
  
  // API Endpoints
  RAINDROP_API_BASE: 'https://api.raindrop.io/rest/v1',
  NOTION_API_BASE: 'https://api.notion.com/v1',
  NOTION_API_VERSION: '2022-06-28',
  
  // Feature toggles
  ENABLE_COVERS: true, // Set to false to disable adding cover images to Notion pages
  ENABLE_ICONS: true, // Set to false to disable adding icons to Notion pages
  ENABLE_TWITTER_ORGANIZATION: true, // Set to false to treat Twitter bookmarks as regular pages
  ENABLE_TWITTER_ICONS: true, // Set to false to disable Twitter logo icons on parent pages
  ENABLE_PAGE_CONTENT: true, // Set to false to disable adding excerpt/note as page content
  ENABLE_DUPLICATE_DETECTION: true, // Set to false to skip duplicate checking (faster but may create duplicates)
  ENABLE_AUTO_DELETE: true, // Set to false to disable automatic deletion of removed bookmarks
  ENABLE_UPDATE_CHECK: true, // Set to false to skip checking existing bookmarks for updates
  
  // Processing settings
  BATCH_SIZE: 100, // Notion allows up to 100 pages per batch request
  RAINDROP_PAGE_SIZE: 50, // Number of bookmarks to fetch per Raindrop API call
  DELAY_BETWEEN_BATCHES: 1000, // Milliseconds to wait between batches
  DELAY_ON_RATE_LIMIT: 5000, // Milliseconds to wait when rate limited
  MAX_RETRIES: 3, // Number of times to retry failed requests
  MAX_TEXT_CHUNK: 1900, // Notion rejects rich text longer than 2000 characters
  MAX_BLOCKS_PER_REQUEST: 100, // Notion rejects more than 100 blocks per request
  MAX_DELETIONS_PER_RUN: 100, // Safety limit: refuse to archive more pages than this in one run
  ALLOW_MASS_DELETION: false, // Set to true to override MAX_DELETIONS_PER_RUN
  
  // Script execution limits (Google Apps Script has 6 min execution limit)
  MAX_EXECUTION_TIME: 5.5 * 60 * 1000, // 5.5 minutes in milliseconds
  
  // Trigger settings
  TRIGGER_HOUR: 20, // 8:00 PM (24-hour format)
  TRIGGER_FUNCTION_NAME: 'syncRaindropToNotion',
};


// ============================================================================
// MAIN FUNCTIONS
// ============================================================================

const TWITTER_ICON_URL = 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png';
const TWEET_ID_LABEL = '🆔 Raindrop ID:';

// Error tracking for logging
let syncErrors = [];
let syncWarnings = [];


// ============================================================================
// HTTP LAYER
// ============================================================================

const MAX_RETRY_DELAY_MS = 30000;

function headerValue(headers, name) {
  const key = Object.keys(headers || {}).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function retryDelay(response, attempt) {
  const retryAfter = parseFloat(headerValue(response.getHeaders(), 'Retry-After'));
  if (retryAfter > 0) return Math.min(retryAfter * 1000, MAX_RETRY_DELAY_MS);
  if (response.getResponseCode() === 429) return CONFIG.DELAY_ON_RATE_LIMIT;
  return 1000 * attempt;
}

/**
 * Send an HTTP request and return the parsed JSON body.
 * Retries 429 always, and 5xx and network errors only when idempotent.
 * Throws an Error with a `status` property on any non-2xx response.
 */
function sendRequest(service, url, { method = 'get', headers = {}, body, idempotent = true } = {}) {
  const options = { method: method, headers: headers, muteHttpExceptions: true };
  if (body !== undefined) {
    options.headers = { ...headers, 'Content-Type': 'application/json' };
    options.payload = JSON.stringify(body);
  }

  const attempts = Math.max(1, CONFIG.MAX_RETRIES);
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response;

    try {
      response = UrlFetchApp.fetch(url, options);
    } catch (error) {
      lastError = error;
      if (!idempotent || attempt === attempts) throw error;
      Logger.log(`Retry ${attempt}/${attempts}: ${error.message}`);
      Utilities.sleep(1000 * attempt);
      continue;
    }

    const code = response.getResponseCode();
    if (code >= 200 && code < 300) {
      const text = response.getContentText();
      return text ? JSON.parse(text) : {};
    }

    lastError = new Error(`${service} API error: ${code} - ${response.getContentText()}`);
    lastError.status = code;

    const retryable = code === 429 || (idempotent && code >= 500);
    if (!retryable || attempt === attempts) throw lastError;

    Logger.log(`⚠️ ${service} API returned ${code}, retry ${attempt}/${attempts}`);
    Utilities.sleep(retryDelay(response, attempt));
  }

  throw lastError;
}

function notionRequest(method, path, body, options = {}) {
  return sendRequest('Notion', `${CONFIG.NOTION_API_BASE}${path}`, {
    method: method,
    headers: {
      'Authorization': `Bearer ${CONFIG.NOTION_API_TOKEN}`,
      'Notion-Version': CONFIG.NOTION_API_VERSION
    },
    body: body,
    ...options
  });
}

function raindropRequest(path) {
  return sendRequest('Raindrop', `${CONFIG.RAINDROP_API_BASE}${path}`, {
    headers: { 'Authorization': `Bearer ${CONFIG.RAINDROP_API_TOKEN}` }
  });
}

// ============================================================================
// PAGINATION
// ============================================================================

function* paginateNotion(fetchPage, delayMs) {
  let cursor;

  do {
    const data = fetchPage(cursor);
    for (const item of data.results || []) {
      yield item;
    }

    cursor = data.has_more ? data.next_cursor : undefined;
    if (cursor && delayMs) {
      Utilities.sleep(delayMs);
    }
  } while (cursor);
}

function queryDatabase(filter, { pageSize = 100, delayMs = 300 } = {}) {
  return paginateNotion(cursor => {
    const body = { page_size: pageSize };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;
    return notionRequest('post', `/databases/${CONFIG.NOTION_DATABASE_ID}/query`, body);
  }, delayMs);
}

function listBlockChildren(blockId, delayMs = 200) {
  return paginateNotion(cursor => {
    const query = cursor ? `?start_cursor=${encodeURIComponent(cursor)}&page_size=100` : '?page_size=100';
    return notionRequest('get', `/blocks/${blockId}/children${query}`);
  }, delayMs);
}

function* raindropPages(delayMs = 0) {
  for (let page = 0; ; page++) {
    const response = fetchRaindropBookmarks(page);

    if (!response || !Array.isArray(response.items)) {
      throw new Error(`Unexpected Raindrop response on page ${page}`);
    }
    if (response.items.length === 0) return;

    yield { page: page, items: response.items };

    if (response.items.length < CONFIG.RAINDROP_PAGE_SIZE) return;
    if (delayMs) Utilities.sleep(delayMs);
  }
}

// ============================================================================
// NOTION BLOCK AND PROPERTY BUILDERS
// ============================================================================

function splitText(text, size = CONFIG.MAX_TEXT_CHUNK) {
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    const lastUnit = text.charCodeAt(end - 1);
    if (end < text.length && lastUnit >= 0xD800 && lastUnit <= 0xDBFF) end--;
    chunks.push(text.substring(start, end));
    start = end;
  }

  return chunks;
}

function richText(content, link) {
  return [{ type: 'text', text: link ? { content: content, link: { url: link } } : { content: content } }];
}

function block(type, richTextItems) {
  return { object: 'block', type: type, [type]: { rich_text: richTextItems } };
}

function emptyParagraph() {
  return block('paragraph', []);
}

function textBlocks(type, text) {
  if (!text) return [];
  return splitText(text).map(chunk => block(type, richText(chunk)));
}

function blockText(b) {
  return (b[b.type]?.rich_text || []).map(t => t.plain_text || '').join('');
}

function contentBlocksText(blocks) {
  return blocks
    .filter(b => b.type === 'paragraph' || b.type === 'quote')
    .map(blockText)
    .join('');
}

function bookmarkContentBlocks(bookmark) {
  return [
    ...textBlocks('paragraph', bookmark.excerpt),
    ...textBlocks('quote', bookmark.note)
  ].slice(0, CONFIG.MAX_BLOCKS_PER_REQUEST);
}

function buildTweetBlocks(tweet) {
  const trailer = [
    block('paragraph', richText(`📅 Saved: ${formatDate(tweet.created)} | ${TWEET_ID_LABEL} ${tweet._id}`)),
    block('paragraph', richText(tweet.link, tweet.link)),
    emptyParagraph(),
    emptyParagraph(),
    emptyParagraph()
  ];

  const content = [
    ...textBlocks('paragraph', tweet.title),
    ...textBlocks('paragraph', tweet.excerpt),
    ...textBlocks('quote', tweet.note)
  ].slice(0, CONFIG.MAX_BLOCKS_PER_REQUEST - trailer.length);

  return [...content, ...trailer];
}

function titleProperty(text) {
  return { title: richText(text) };
}

function richTextProperty(text) {
  return { rich_text: richText(text) };
}

function selectProperty(name) {
  return { select: { name: name } };
}

function multiSelectProperty(names) {
  return { multi_select: names.map(name => ({ name: name })) };
}

function dateProperty(start) {
  return { date: { start: start } };
}

function urlProperty(url) {
  return { url: url };
}

function externalFile(url) {
  return { type: 'external', external: { url: url } };
}

function pageTitle(bookmark) {
  return splitText(bookmark.title || bookmark.link || 'Untitled')[0];
}

function bookmarkCoverUrl(bookmark) {
  if (!bookmark.cover) return '';
  return (typeof bookmark.cover === 'string' ? bookmark.cover : bookmark.cover.url) || '';
}

function coverAndIcon(bookmark) {
  const url = bookmarkCoverUrl(bookmark);
  const result = {};
  if (!url) return result;
  if (CONFIG.ENABLE_COVERS) result.cover = externalFile(url);
  if (CONFIG.ENABLE_ICONS) result.icon = externalFile(url);
  return result;
}

function bookmarkProperties(bookmark, titlePropName) {
  return {
    [titlePropName]: titleProperty(pageTitle(bookmark)),
    'Type': selectProperty(bookmark.type || 'link'),
    'Collection': selectProperty(bookmark.collectionName || 'Unsorted'),
    'Tags': multiSelectProperty(bookmark.tags || [])
  };
}

function collectTags(bookmarks) {
  const tags = new Set();
  for (const bookmark of bookmarks) {
    if (Array.isArray(bookmark.tags)) {
      bookmark.tags.forEach(tag => tags.add(tag));
    }
  }
  return Array.from(tags);
}


// ============================================================================
// MAIN FUNCTIONS
// ============================================================================

function setupDatabaseProperties() {
  validateConfiguration(['NOTION_API_TOKEN', 'NOTION_DATABASE_ID']);
  Logger.log('Setting up Notion database properties...');

  // Do not attempt to create/rename the title property. We'll use whatever the DB already has.
  // Only ensure our custom properties exist.
  const properties = {
    'Raindrop ID': { rich_text: {} },
    'URL': { url: {} },
    'Type': {
      select: {
        options: [
          { name: 'link', color: 'gray' },
          { name: 'article', color: 'blue' },
          { name: 'image', color: 'green' },
          { name: 'video', color: 'red' },
          { name: 'document', color: 'yellow' },
          { name: 'audio', color: 'purple' },
          { name: 'tweet', color: 'pink' },
          { name: 'tweets', color: 'orange' }
        ]
      }
    },
    'Collection': { select: {} },
    'Tags': { multi_select: {} },
    'Date Saved': { date: {} }
  };

  try {
    notionRequest('patch', `/databases/${CONFIG.NOTION_DATABASE_ID}`, { properties: properties });
    Logger.log('✓ Database properties configured successfully');
    return true;
  } catch (error) {
    Logger.log(`❌ Error setting up database: ${error.message}`);
    return false;
  }
}

function syncRaindropToNotion() {
  const startTime = new Date().getTime();
  // Reset error tracking
  syncErrors = [];
  syncWarnings = [];
  
  Logger.log('=== Starting Raindrop to Notion Sync ===');
  Logger.log('Start time: ' + new Date().toISOString());
  
  // CRITICAL: Validate configuration before proceeding
  validateConfiguration();
  
  try {
    // Ensure we know the database title property name
    const titleProp = getDatabaseTitlePropertyName();
    Logger.log(`Using Notion title property: ${titleProp}`);
    
    // Get existing Raindrop IDs from Notion to avoid duplicates and track updates
    let existingData;
    let existingIds;
    let idToPageMap;
    
    if (CONFIG.ENABLE_DUPLICATE_DETECTION) {
      try {
        existingData = getExistingRaindropIds();
        existingIds = existingData.idSet;
        idToPageMap = existingData.idToPageMap;
        Logger.log(`Found ${existingIds.size} existing bookmarks in Notion`);
      } catch (error) {
        Logger.log(`❌ CRITICAL ERROR: Failed to fetch existing IDs - ${error.message}`);
        Logger.log('❌ ABORTING SYNC to prevent duplicate creation');
        throw new Error(`Cannot proceed safely without existing IDs: ${error.message}`);
      }
    } else {
      Logger.log('⚠️ WARNING: Duplicate detection is disabled - all bookmarks will be imported');
      existingIds = new Set();
      idToPageMap = new Map();
    }
    
    // Delete Notion pages for bookmarks that no longer exist in Raindrop
    if (CONFIG.ENABLE_AUTO_DELETE) {
      deleteRemovedBookmarks();
      Logger.log('Completed cleanup of deleted bookmarks');
    } else {
      Logger.log('Auto-delete is disabled, skipping cleanup of deleted bookmarks');
    }
    
    // Check if we're already running low on time after cleanup
    const elapsedAfterCleanup = new Date().getTime() - startTime;
    if (elapsedAfterCleanup > CONFIG.MAX_EXECUTION_TIME * 0.7) {
      Logger.log(`⚠️ Cleanup took ${(elapsedAfterCleanup / 1000).toFixed(1)}s. Skipping sync to avoid timeout.`);
      Logger.log('New bookmarks will be synced on next trigger.');
      return;
    }
    
    // Validate we have proper duplicate detection data (only skip if it's genuinely the first run)
    if (CONFIG.ENABLE_DUPLICATE_DETECTION && existingIds.size === 0) {
      const isFirstRun = confirmFirstRun();
      if (!isFirstRun) {
        Logger.log('❌ CRITICAL: Zero existing IDs found but this is not the first run');
        Logger.log('❌ This would create massive duplicates - ABORTING');
        throw new Error('Duplicate detection failed - cannot proceed safely');
      } else {
        Logger.log('✓ Confirmed: This appears to be the first sync run');
      }
    }
    
    // Get Twitter parent pages (or create them as needed)
    const twitterParents = {}; // Maps @username to Notion page ID
    
    // Fetch all bookmarks from Raindrop.io
    let totalProcessed = 0;
    let totalSkipped = 0;
    let totalCreated = 0;
    let totalUpdated = 0;

    for (const { page, items: bookmarks } of raindropPages(CONFIG.DELAY_BETWEEN_BATCHES)) {
      // Check execution time limit
      const elapsed = new Date().getTime() - startTime;
      if (elapsed > CONFIG.MAX_EXECUTION_TIME) {
        Logger.log(`⚠️ Approaching execution time limit. Processed ${totalProcessed} bookmarks.`);
        Logger.log('Script will resume on next trigger.');
        break;
      }

      // Enrich bookmarks with derived metadata (collection name, type, tags)
      enrichBookmarksMetadata(bookmarks);
      Logger.log(`\nProcessing page ${page}: ${bookmarks.length} bookmarks`);

      const newBookmarks = bookmarks.filter(b => !existingIds.has(b._id.toString()));
      const existingBookmarks = bookmarks.filter(b => existingIds.has(b._id.toString()));

      Logger.log(`New bookmarks to import: ${newBookmarks.length}`);
      Logger.log(`Existing bookmarks to check for updates: ${existingBookmarks.length}`);
      totalSkipped += bookmarks.length - newBookmarks.length - existingBookmarks.length;

      // Check existing bookmarks for updates
      if (existingBookmarks.length > 0 && CONFIG.ENABLE_UPDATE_CHECK) {
        Logger.log(`Checking ${existingBookmarks.length} existing bookmarks for updates...`);
        const updateResult = checkAndUpdateBookmarks(existingBookmarks, idToPageMap, startTime);
        totalUpdated += updateResult.updated;

        // If we're out of time during updates, stop processing
        if (updateResult.outOfTime) {
          Logger.log(`⚠️ Approaching execution time limit during updates. Processed ${totalProcessed} bookmarks.`);
          Logger.log('Script will resume on next trigger.');
          break;
        }
      } else if (existingBookmarks.length > 0 && !CONFIG.ENABLE_UPDATE_CHECK) {
        Logger.log(`Update check is disabled, skipping ${existingBookmarks.length} existing bookmarks`);
      }

      // Articles from Twitter stay regular bookmarks; only Twitter/Unsorted collections get parent pages
      const twitterBookmarks = newBookmarks.filter(isOrganizedTwitterBookmark);
      const regularBookmarks = newBookmarks.filter(b => !isOrganizedTwitterBookmark(b));

      if (twitterBookmarks.length > 0) {
        Logger.log(`Processing ${twitterBookmarks.length} Twitter bookmarks...`);
        totalCreated += processTwitterBookmarks(twitterBookmarks, twitterParents, existingIds);
      }

      if (regularBookmarks.length > 0) {
        Logger.log(`Processing ${regularBookmarks.length} regular bookmarks...`);
        totalCreated += processBatchBookmarks(regularBookmarks, existingIds);
      }

      totalProcessed += bookmarks.length;
    }

    // Final summary
    const endTime = new Date().getTime();
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    
    Logger.log('\n=== Sync Complete ===');
    Logger.log(`Total bookmarks processed: ${totalProcessed}`);
    Logger.log(`Skipped (already exist): ${totalSkipped}`);
    Logger.log(`Created in Notion: ${totalCreated}`);
    Logger.log(`Updated in Notion: ${totalUpdated}`);
    Logger.log(`Duration: ${duration} seconds`);
    Logger.log(`End time: ${new Date().toISOString()}`);
    

    
  } catch (error) {
    Logger.log(`❌ ERROR: ${error.message}`);
    Logger.log(error.stack);
    
    // Track critical error
    syncErrors.push({
      type: 'CRITICAL',
      message: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
    

    
    throw error;
  }
}

function createDailyTrigger() {
  // First, check if trigger already exists
  const triggers = ScriptApp.getProjectTriggers();
  const existingTrigger = triggers.find(t => 
    t.getHandlerFunction() === CONFIG.TRIGGER_FUNCTION_NAME &&
    t.getEventType() === ScriptApp.EventType.CLOCK
  );
  
  if (existingTrigger) {
    Logger.log('✓ Daily trigger already exists');
    Logger.log(`Trigger will run ${CONFIG.TRIGGER_FUNCTION_NAME} every day at ${CONFIG.TRIGGER_HOUR}:00`);
    return;
  }
  
  // Create new daily trigger
  ScriptApp.newTrigger(CONFIG.TRIGGER_FUNCTION_NAME)
    .timeBased()
    .atHour(CONFIG.TRIGGER_HOUR)
    .everyDays(1)
    .create();
  
  Logger.log('✓ Daily trigger created successfully');
  Logger.log(`${CONFIG.TRIGGER_FUNCTION_NAME} will run every day at ${CONFIG.TRIGGER_HOUR}:00 (${formatHour(CONFIG.TRIGGER_HOUR)})`);
}

// ============================================================================
// RAINDROP.IO API FUNCTIONS
// ============================================================================

/**
 * Fetch bookmarks from Raindrop.io with pagination
 * @param {number} page - Page number (0-indexed)
 * @returns {Object} Response with items array
 */
function fetchRaindropBookmarks(page = 0) {
  return raindropRequest(`/raindrops/0?perpage=${CONFIG.RAINDROP_PAGE_SIZE}&page=${page}&sort=-created`);
}

/**
 * Fetch collection details from Raindrop.io
 * @param {number} collectionId - Collection ID
 * @returns {Object} Collection details
 */
function fetchRaindropCollection(collectionId) {
  if (!collectionId || collectionId === 0) {
    return { title: 'Unsorted' };
  }

  try {
    return raindropRequest(`/collection/${collectionId}`).item;
  } catch (error) {
    if (error.status && error.status !== 429) {
      return { title: 'Unknown Collection' };
    }
    throw error;
  }
}

/**
 * Get all current Raindrop bookmark IDs
 * @returns {Set} Set of all current Raindrop IDs
 */
function getAllRaindropIds() {
  const raindropIds = new Set();

  for (const { items } of raindropPages(300)) {
    items.forEach(bookmark => {
      if (bookmark._id) {
        raindropIds.add(bookmark._id.toString());
      }
    });
  }

  return raindropIds;
}

// ============================================================================
// NOTION API FUNCTIONS
// ============================================================================

/**
 * Query Notion database to get existing Raindrop IDs with their Notion page IDs
 * Also checks Twitter parent pages for tweets containing Raindrop IDs
 * @returns {Object} Object with two properties:
 *   - idSet: Set of existing Raindrop IDs
 *   - idToPageMap: Map of Raindrop ID -> {notionPageId, lastEditedTime, isTwitterChild}
 */
function getExistingRaindropIds() {
  const existingIds = new Set();
  const idToPageMap = new Map();

  try {
    for (const page of queryDatabase()) {
      const raindropId = page.properties?.['Raindrop ID']?.rich_text?.[0]?.plain_text;
      if (raindropId) {
        existingIds.add(raindropId);
        idToPageMap.set(raindropId, {
          notionPageId: page.id,
          lastEditedTime: page.last_edited_time,
          isTwitterChild: false
        });
      }

      if (page.properties?.['Type']?.select?.name === 'tweets') {
        try {
          getTwitterChildBlocksWithRaindropIds(page.id).forEach(info => {
            existingIds.add(info.raindropId);
            idToPageMap.set(info.raindropId, {
              notionPageId: page.id,
              lastEditedTime: page.last_edited_time,
              isTwitterChild: true,
              blockIds: info.blockIds
            });
          });
        } catch (error) {
          Logger.log(`Warning: Error checking children of ${page.id}: ${error.message}`);
        }
      }
    }
  } catch (error) {
    Logger.log(`❌ CRITICAL: Failed to fetch existing IDs: ${error.message}`);
    Logger.log('❌ This would create massive duplicates - ABORTING IMMEDIATELY');
    throw new Error(`DUPLICATE PREVENTION: Cannot proceed without existing IDs: ${error.message}`);
  }

  return { idSet: existingIds, idToPageMap: idToPageMap };
}

/**
 * Delete Notion pages for bookmarks that no longer exist in Raindrop
 * Compares all Notion pages with current Raindrop bookmarks and removes orphaned entries
 */
function deleteRemovedBookmarks() {
  Logger.log('\n=== Checking for deleted bookmarks ===');
  
  try {
    // Get all current Raindrop IDs
    const currentRaindropIds = getAllRaindropIds();
    Logger.log(`Found ${currentRaindropIds.size} bookmarks in Raindrop`);
    
    // Get all Notion pages with their Raindrop IDs and page IDs
    const notionPages = getAllNotionPagesWithRaindropIds();
    Logger.log(`Found ${notionPages.length} pages in Notion to check`);
    
    // Find pages that should be deleted (exist in Notion but not in Raindrop)
    const pagesToDelete = notionPages.filter(page => 
      !currentRaindropIds.has(page.raindropId)
    );
    
    if (currentRaindropIds.size === 0 && notionPages.length > 0) {
      throw new Error('Raindrop returned no bookmarks; refusing to archive Notion pages');
    }

    if (pagesToDelete.length > CONFIG.MAX_DELETIONS_PER_RUN && !CONFIG.ALLOW_MASS_DELETION) {
      throw new Error(
        `Refusing to archive ${pagesToDelete.length} pages (limit ${CONFIG.MAX_DELETIONS_PER_RUN}). ` +
        'Set ALLOW_MASS_DELETION to true if this is intended.'
      );
    }

    if (pagesToDelete.length === 0) {
      Logger.log('✓ No deleted bookmarks found');
    } else {
      Logger.log(`Found ${pagesToDelete.length} pages to delete`);
      
      // Delete pages
      let deletedCount = 0;
      let failedCount = 0;
      
      for (const page of pagesToDelete) {
        try {
          deleteNotionPage(page.notionPageId);
          deletedCount++;
          Logger.log(`✓ Deleted: ${page.title} (Raindrop ID: ${page.raindropId})`);
          
          // Small delay to avoid rate limiting
          Utilities.sleep(200);
        } catch (error) {
          failedCount++;
          Logger.log(`❌ Failed to delete ${page.title}: ${error.message}`);
        }
      }
      
      Logger.log(`\nDeletion summary: ${deletedCount} deleted, ${failedCount} failed`);
    }
    
    // Also check Twitter parent pages for deleted tweets
    deleteRemovedTweetsFromParents(currentRaindropIds);
    
  } catch (error) {
    Logger.log(`❌ Error in deleteRemovedBookmarks: ${error.message}`);
    Logger.log(error.stack);
  }
}

/**
 * Delete tweet content blocks from Twitter parent pages for tweets that no longer exist in Raindrop
 * @param {Set} currentRaindropIds - Set of current Raindrop IDs
 */
function deleteRemovedTweetsFromParents(currentRaindropIds) {
  Logger.log('\n=== Checking for deleted tweets in Twitter parent pages ===');

  try {
    const titleProp = getDatabaseTitlePropertyName();
    let totalDeletedTweets = 0;
    let totalDeletedBlocks = 0;
    const emptyParents = [];

    for (const page of queryDatabase({ property: 'Type', select: { equals: 'tweets' } })) {
      const parentTitle = page.properties[titleProp]?.title?.[0]?.plain_text || 'Unknown';
      const tweets = getTwitterChildBlocksWithRaindropIds(page.id);
      const tweetsToDelete = tweets.filter(tweet => !currentRaindropIds.has(tweet.raindropId));

      if (tweetsToDelete.length === 0) continue;

      Logger.log(`Found ${tweetsToDelete.length} deleted tweet(s) in ${parentTitle}`);

      for (const tweet of tweetsToDelete) {
        for (const blockId of tweet.blockIds) {
          try {
            deleteNotionBlock(blockId);
            totalDeletedBlocks++;
            Utilities.sleep(150);
          } catch (error) {
            Logger.log(`  ⚠️ Failed to delete block ${blockId}: ${error.message}`);
          }
        }
        totalDeletedTweets++;
        Logger.log(`  ✓ Deleted tweet with ${tweet.blockIds.length} blocks (Raindrop ID: ${tweet.raindropId})`);
      }

      if (tweetsToDelete.length === tweets.length) {
        emptyParents.push({ id: page.id, title: parentTitle });
      }
    }

    if (totalDeletedTweets > 0) {
      Logger.log(`\n✓ Deleted ${totalDeletedTweets} tweet(s) (${totalDeletedBlocks} blocks) from parent pages`);
    } else {
      Logger.log('✓ No deleted tweets found in parent pages');
    }

    if (emptyParents.length > 0) {
      Logger.log(`\n=== Deleting ${emptyParents.length} empty Twitter parent page(s) ===`);
      for (const parent of emptyParents) {
        try {
          deleteNotionPage(parent.id);
          Logger.log(`✓ Deleted empty parent: ${parent.title}`);
          Utilities.sleep(200);
        } catch (error) {
          Logger.log(`❌ Failed to delete empty parent ${parent.title}: ${error.message}`);
        }
      }
    }

  } catch (error) {
    Logger.log(`❌ Error in deleteRemovedTweetsFromParents: ${error.message}`);
    Logger.log(error.stack);
  }
}

/**
 * Get all Notion pages with their Raindrop IDs
 * A failed fetch returns the pages read so far, which can only reduce deletions
 * @returns {Array} Array of objects with {notionPageId, raindropId, title, type}
 */
function getAllNotionPagesWithRaindropIds() {
  const titleProp = getDatabaseTitlePropertyName();
  const pages = [];

  try {
    for (const page of queryDatabase()) {
      const raindropId = page.properties?.['Raindrop ID']?.rich_text?.[0]?.plain_text;
      if (!raindropId) continue;

      pages.push({
        notionPageId: page.id,
        raindropId: raindropId,
        title: page.properties[titleProp]?.title?.[0]?.plain_text || 'Untitled',
        type: page.properties['Type']?.select?.name
      });
    }
  } catch (error) {
    Logger.log(`❌ Error fetching Notion pages: ${error.message}`);
  }

  return pages;
}

const TWEET_ID_PATTERN = new RegExp(`${TWEET_ID_LABEL} (\\w+)`);

/**
 * Group the blocks of a Twitter parent page into tweets
 * Tweet structure: [content blocks...] [metadata with ID] [link] [3 empty lines]
 * @param {Array} allBlocks - All child blocks of the parent page, in order
 * @returns {Array} Array of objects with {raindropId, blockIds: [array of block IDs to delete]}
 */
function groupTweetBlocks(allBlocks) {
  const tweets = [];

  // Find blocks with Raindrop IDs and collect all related blocks for each tweet
  for (let i = 0; i < allBlocks.length; i++) {
    const block = allBlocks[i];
    
    // Check if this block contains a Raindrop ID
    if (block.type === 'paragraph' && block.paragraph && block.paragraph.rich_text) {
      const text = block.paragraph.rich_text.map(t => t.plain_text).join('');
      const raindropIdMatch = text.match(TWEET_ID_PATTERN);
      
      if (raindropIdMatch && raindropIdMatch[1]) {
        const raindropId = raindropIdMatch[1];
        const blockIds = [];
        
        // Collect all blocks for this tweet
        // Tweet structure: [content blocks...] [metadata with ID] [link] [3 empty lines]
        
        // Add the metadata block (current block)
        blockIds.push(block.id);
        
        // Look for the link block (next block after metadata)
        if (i + 1 < allBlocks.length) {
          blockIds.push(allBlocks[i + 1].id);
        }
        
        // Look for empty line blocks after the link (up to 3)
        let emptyCount = 0;
        for (let j = i + 2; j < allBlocks.length && emptyCount < 3; j++) {
          const nextBlock = allBlocks[j];
          if (nextBlock.type === 'paragraph' && 
              nextBlock.paragraph.rich_text.length === 0) {
            blockIds.push(nextBlock.id);
            emptyCount++;
          } else {
            break; // Stop if we hit a non-empty block
          }
        }
        
        // Look backwards for content blocks (before metadata)
        // Content could be multiple paragraphs
        for (let j = i - 1; j >= 0; j--) {
          const prevBlock = allBlocks[j];
          
          // Stop if we hit another tweet's metadata or empty spacing
          if (prevBlock.type === 'paragraph' && prevBlock.paragraph.rich_text.length > 0) {
            const prevText = prevBlock.paragraph.rich_text.map(t => t.plain_text).join('');
            
            // Check if this is another tweet's metadata or link
            if (prevText.includes(TWEET_ID_LABEL) || 
                prevText.includes('twitter.com') || 
                prevText.includes('x.com')) {
              break;
            }
            
            // This is content, add it
            blockIds.unshift(prevBlock.id); // Add to beginning
          } else if (prevBlock.type === 'quote') {
            blockIds.unshift(prevBlock.id); // Notes are stored as quote blocks
          } else if (prevBlock.type === 'paragraph' && prevBlock.paragraph.rich_text.length === 0) {
            // Empty line - could be spacing from previous tweet, stop here
            break;
          } else {
            break;
          }
        }
        
        tweets.push({
          raindropId: raindropId,
          blockIds: blockIds
        });
      }
    }
  }

  return tweets;
}

/**
 * Get Twitter child blocks with their Raindrop IDs from a parent page
 * @param {string} parentPageId - ID of the Twitter parent page
 * @returns {Array} Array of objects with {raindropId, blockIds}
 */
function getTwitterChildBlocksWithRaindropIds(parentPageId) {
  try {
    return groupTweetBlocks(Array.from(listBlockChildren(parentPageId)));
  } catch (error) {
    throw new Error(`Failed to read blocks of ${parentPageId}: ${error.message}`);
  }
}

/**
 * Delete a Notion page by archiving it
 * @param {string} pageId - ID of the page to delete
 */
function deleteNotionPage(pageId) {
  return notionRequest('patch', `/pages/${pageId}`, { archived: true });
}

/**
 * Delete a Notion block
 * @param {string} blockId - ID of the block to delete
 */
function deleteNotionBlock(blockId) {
  return notionRequest('delete', `/blocks/${blockId}`);
}

/**
 * Update an existing Notion page with bookmark data
 * @param {string} pageId - Notion page ID to update
 * @param {Object} bookmark - Raindrop bookmark object with updated data
 * @returns {Object} Updated page response
 */
function updateNotionPage(pageId, bookmark) {
  const payload = {
    properties: bookmarkProperties(bookmark, getDatabaseTitlePropertyName()),
    ...coverAndIcon(bookmark)
  };

  const result = notionRequest('patch', `/pages/${pageId}`, payload);

  // Always call to handle deletions
  if (CONFIG.ENABLE_PAGE_CONTENT) {
    try {
      updatePageContentWithExcerptAndNote(pageId, bookmark);
    } catch (error) {
      Logger.log(`  ⚠️ Failed to update page content: ${error.message}`);
    }
  }

  return result;
}

/**
 * Replace page content with the bookmark's excerpt and note (matching create behavior)
 * @param {string} pageId - Notion page ID
 * @param {Object} bookmark - Bookmark object with excerpt and/or note
 */
function updatePageContentWithExcerptAndNote(pageId, bookmark) {
  try {
    const existingBlocks = Array.from(listBlockChildren(pageId));

    for (const existing of existingBlocks) {
      if (existing.type === 'paragraph' || existing.type === 'quote') {
        try {
          deleteNotionBlock(existing.id);
          Utilities.sleep(100);
        } catch (error) {
          Logger.log(`Warning: Could not delete block ${existing.id}: ${error.message}`);
        }
      }
    }

    const newBlocks = bookmarkContentBlocks(bookmark);
    if (newBlocks.length > 0) {
      notionRequest('patch', `/blocks/${pageId}/children`, { children: newBlocks }, { idempotent: false });
    }
  } catch (error) {
    Logger.log(`Warning: Could not update page content: ${error.message}`);
  }
}

/**
 * Create a page in Notion database
 * @param {Object} bookmark - Raindrop bookmark object
 * @returns {Object} Created page response
 */
function createNotionPage(bookmark) {
  if (isOrganizedTwitterBookmark(bookmark)) {
    throw new Error('Twitter bookmarks in Twitter collection should be handled by addTweetsToParentPage function');
  }

  const pageData = {
    parent: { database_id: CONFIG.NOTION_DATABASE_ID },
    properties: {
      ...bookmarkProperties(bookmark, getDatabaseTitlePropertyName()),
      'Raindrop ID': richTextProperty(bookmark._id.toString()),
      'URL': urlProperty(bookmark.link),
      'Date Saved': dateProperty(bookmark.created)
    },
    ...coverAndIcon(bookmark)
  };

  if (CONFIG.ENABLE_PAGE_CONTENT) {
    const children = bookmarkContentBlocks(bookmark);
    if (children.length > 0) {
      pageData.children = children;
    }
  }

  return notionRequest('post', '/pages', pageData, { idempotent: false });
}

/**
 * Create multiple pages in Notion
 * Note: Notion doesn't have a true batch create API, so we batch our calls
 * @param {Array} bookmarks - Array of bookmark objects
 * @param {Set} existingIdsSet - Optional set to record created Raindrop IDs in
 * @returns {number} Number of successfully created pages
 */
function createNotionPagesBatch(bookmarks, existingIdsSet = null) {
  let successCount = 0;
  let failureCount = 0;
  
  for (let i = 0; i < bookmarks.length; i++) {
    try {
      const created = createNotionPage(bookmarks[i]);
      if (existingIdsSet) existingIdsSet.add(bookmarks[i]._id.toString());
      successCount++;
      
      // Small delay between individual creates within a batch
      if (i < bookmarks.length - 1) {
        Utilities.sleep(100);
      }
    } catch (error) {
      failureCount++;
      logError('ERROR', `Failed to create page for "${bookmarks[i].title}"`, {
        bookmark: bookmarks[i].title || bookmarks[i].link,
        error: error.message
      });
      Logger.log(`❌ Failed to create page for "${bookmarks[i].title}": ${error.message}`);
      
      // If we're getting too many failures, something is seriously wrong - abort to prevent partial sync
      if (failureCount > 5 && failureCount > successCount * 0.5) {
        Logger.log(`❌ CRITICAL: Too many failures (${failureCount}/${i+1}). Aborting batch to prevent partial sync.`);
        throw new Error(`Batch creation failed: ${failureCount} failures out of ${i+1} attempts`);
      }
    }
  }
  
  return successCount;
}

/**
 * Create or get a Twitter parent page
 * @param {string} username - Twitter handle (with or without @)
 * @param {Object} twitterParents - Cache of existing parent pages
 * @param {Object} latestBookmark - Latest bookmark for this user to get the date
 * @param {Array} allUserBookmarks - All bookmarks for this user to collect tags
 * @returns {string} Notion page ID of the parent page
 */
function getOrCreateTwitterParent(username, twitterParents, latestBookmark = null, allUserBookmarks = []) {
  const handle = username.startsWith('@') ? username : `@${username}`;

  if (twitterParents[handle]) {
    return twitterParents[handle];
  }

  const titleProp = getDatabaseTitlePropertyName();
  const filter = {
    and: [
      { property: titleProp, title: { contains: handle } },
      { property: 'Type', select: { equals: 'tweets' } }
    ]
  };

  // A failed search throws instead of creating a second parent page for the same user
  let candidates = 0;
  for (const page of queryDatabase(filter)) {
    candidates++;
    const title = page.properties[titleProp]?.title?.[0]?.plain_text || '';

    if (title === `${handle} on Twitter` || title === handle) {
      twitterParents[handle] = page.id;
      Logger.log(`  ✓ Found existing Twitter parent page for ${handle}`);
      updateTwitterParentTags(page.id, allUserBookmarks);
      return page.id;
    }
  }

  if (candidates > 0) {
    Logger.log(`  ℹ️ Found ${candidates} pages containing "${handle}" but none matched exactly`);
  }

  Logger.log(`Creating Twitter parent page: ${handle}`);

  const properties = {
    [titleProp]: titleProperty(`${handle} on Twitter`),
    'Type': selectProperty('tweets'),
    'Collection': selectProperty('Twitter'),
    'Date Saved': dateProperty(latestBookmark ? latestBookmark.created : new Date().toISOString())
  };

  const tags = collectTags(allUserBookmarks);
  if (tags.length > 0) {
    properties['Tags'] = multiSelectProperty(tags);
    Logger.log(`Adding tags to ${handle}: ${tags.join(', ')}`);
  }

  const pageData = {
    parent: { database_id: CONFIG.NOTION_DATABASE_ID },
    properties: properties
  };

  if (CONFIG.ENABLE_TWITTER_ICONS) {
    pageData.icon = externalFile(TWITTER_ICON_URL);
    Logger.log(`Adding Twitter logo icon for ${handle}`);
  }

  const createdPage = notionRequest('post', '/pages', pageData, { idempotent: false });

  if (!createdPage.id) {
    throw new Error(`Failed to create Twitter parent page for ${handle}`);
  }

  twitterParents[handle] = createdPage.id;
  return createdPage.id;
}

/**
 * Update an existing Twitter parent page with tags from bookmarks
 * @param {string} pageId - ID of the parent page
 * @param {Array} userBookmarks - All bookmarks for this user to collect tags
 */
function updateTwitterParentTags(pageId, userBookmarks) {
  try {
    const tags = collectTags(userBookmarks);
    if (tags.length === 0) return;

    notionRequest('patch', `/pages/${pageId}`, { properties: { 'Tags': multiSelectProperty(tags) } });
    Logger.log(`✓ Updated parent page tags: ${tags.join(', ')}`);
  } catch (error) {
    Logger.log(`Warning: Error updating parent page tags: ${error.message}`);
  }
}

// ============================================================================
// PROCESSING FUNCTIONS
// ============================================================================

function isOrganizedTwitterBookmark(bookmark) {
  return CONFIG.ENABLE_TWITTER_ORGANIZATION &&
    isTwitterUrl(bookmark.link) &&
    (bookmark.collectionName === 'Twitter' || bookmark.collectionName === 'Unsorted');
}

/**
 * Check if a bookmark needs updating by comparing with Notion page
 * @param {string} pageId - Notion page ID
 * @param {Object} bookmark - Raindrop bookmark data
 * @returns {boolean} True if update is needed
 */
function bookmarkNeedsUpdate(pageId, bookmark) {
  try {
    const page = notionRequest('get', `/pages/${pageId}`);
    const props = page.properties;
    const titleProp = getDatabaseTitlePropertyName();

    if ((props[titleProp]?.title?.[0]?.plain_text || '') !== pageTitle(bookmark)) return true;
    if ((props['Type']?.select?.name || '') !== (bookmark.type || 'link')) return true;
    if ((props['Collection']?.select?.name || '') !== (bookmark.collectionName || 'Unsorted')) return true;

    const currentTags = (props['Tags']?.multi_select || []).map(t => t.name).sort();
    const newTags = [...(bookmark.tags || [])].sort();
    if (currentTags.length !== newTags.length || currentTags.some((tag, i) => tag !== newTags[i])) return true;

    if ((page.cover?.external?.url || '') !== bookmarkCoverUrl(bookmark)) return true;

    if (CONFIG.ENABLE_PAGE_CONTENT) {
      try {
        const currentContent = contentBlocksText(Array.from(listBlockChildren(pageId)));
        const newContent = (bookmark.excerpt || '') + (bookmark.note || '');

        if (currentContent.trim() !== newContent.trim()) return true;
      } catch (error) {
        Logger.log(`  ⚠️ Could not check content blocks: ${error.message}`);
      }
    }

    return false;

  } catch (error) {
    Logger.log(`  ⚠️ Error checking if bookmark needs update: ${error.message}`);
    return false; // Assume no update needed if we can't check
  }
}

/**
 * Check existing bookmarks for updates and apply changes to Notion
 * @param {Array} bookmarks - Array of bookmark objects to check
 * @param {Map} idToPageMap - Map of Raindrop ID to Notion page info
 * @param {number} startTime - Script start time for execution limit checking
 * @returns {Object} Object with {updated: number, outOfTime: boolean}
 */
function checkAndUpdateBookmarks(bookmarks, idToPageMap, startTime) {
  let updatedCount = 0;
  let skippedCount = 0;
  let outOfTime = false;
  
  for (let i = 0; i < bookmarks.length; i++) {
    // Check execution time before each check
    const elapsed = new Date().getTime() - startTime;
    if (elapsed > CONFIG.MAX_EXECUTION_TIME) {
      Logger.log(`⚠️ Time limit reached after checking ${i} of ${bookmarks.length} bookmarks`);
      outOfTime = true;
      break;
    }
    
    const bookmark = bookmarks[i];
    const raindropId = bookmark._id.toString();
    const pageInfo = idToPageMap.get(raindropId);
    
    if (!pageInfo) continue;
    
    try {
      // Skip Twitter children for now - they take too long
      if (pageInfo.isTwitterChild) {
        skippedCount++;
        continue;
      }
      
      // Check if update is actually needed
      const needsUpdate = bookmarkNeedsUpdate(pageInfo.notionPageId, bookmark);
      
      if (needsUpdate) {
        updateNotionPage(pageInfo.notionPageId, bookmark);
        updatedCount++;
        Logger.log(`  ✓ Updated: ${bookmark.title || bookmark.link}`);
      } else {
        skippedCount++;
      }
      
      // Small delay to avoid rate limiting
      Utilities.sleep(150);
      
    } catch (error) {
      Logger.log(`  ❌ Failed to check/update ${bookmark.title || bookmark.link}: ${error.message}`);
    }
  }
  
  if (updatedCount > 0) {
    Logger.log(`✓ Updated ${updatedCount} bookmarks (${skippedCount} unchanged)`);
  } else {
    Logger.log(`✓ No updates needed (checked ${skippedCount} bookmarks, all unchanged)`);
  }
  
  return { updated: updatedCount, outOfTime: outOfTime };
}

/**
 * Process regular (non-Twitter) bookmarks in batches
 * @param {Array} bookmarks - Array of bookmark objects
 * @param {Set} existingIdsSet - Optional set to record created Raindrop IDs in
 * @returns {number} Number of created pages
 */
function processBatchBookmarks(bookmarks, existingIdsSet = null) {
  let totalCreated = 0;

  for (let i = 0; i < bookmarks.length; i += CONFIG.BATCH_SIZE) {
    const batch = bookmarks.slice(i, i + CONFIG.BATCH_SIZE);
    const batchNumber = Math.floor(i / CONFIG.BATCH_SIZE) + 1;
    Logger.log(`Creating batch ${batchNumber}: ${batch.length} pages`);

    const created = createNotionPagesBatch(batch, existingIdsSet);
    totalCreated += created;

    if (created < batch.length) {
      logError('WARNING', `Only created ${created} of ${batch.length} pages in batch`, {
        batchNumber: batchNumber,
        expected: batch.length,
        actual: created
      });
    }

    Logger.log(`✓ Created ${created} pages in this batch`);

    if (i + CONFIG.BATCH_SIZE < bookmarks.length) {
      Utilities.sleep(CONFIG.DELAY_BETWEEN_BATCHES);
    }
  }

  return totalCreated;
}

/**
 * Process Twitter bookmarks, organizing them under parent pages
 * @param {Array} bookmarks - Array of Twitter bookmark objects
 * @param {Object} twitterParents - Cache of Twitter parent pages
 * @returns {number} Number of created pages
 */
function processTwitterBookmarks(bookmarks, twitterParents, existingIdsSet = null) {
  // Group bookmarks by Twitter handle
  const groupedByHandle = {};
  
  for (const bookmark of bookmarks) {
    const username = extractTwitterHandle(bookmark.link);
    if (username) {
      if (!groupedByHandle[username]) {
        groupedByHandle[username] = [];
      }
      groupedByHandle[username].push(bookmark);
    }
  }
  
  let totalCreated = 0;
  
  // Process each group
  for (const username in groupedByHandle) {
    const userBookmarks = groupedByHandle[username];
    Logger.log(`Processing ${userBookmarks.length} tweets from ${username}`);
    
    try {
      // Get or create parent page for this user
      const latestBookmark = [...userBookmarks].sort((a, b) => new Date(b.created) - new Date(a.created))[0];
      const parentId = getOrCreateTwitterParent(username, twitterParents, latestBookmark, userBookmarks);
      
      const addedIds = addTweetsToParentPage(parentId, userBookmarks);
      totalCreated += addedIds.length;

      if (existingIdsSet) {
        addedIds.forEach(id => existingIdsSet.add(id));
      }

    } catch (error) {
      logError('ERROR', `Error processing Twitter user ${username}`, {
        username: username,
        bookmarkCount: userBookmarks.length,
        error: error.message
      });
      Logger.log(`❌ Error processing Twitter user ${username}: ${error.message}`);
    }
    
    Utilities.sleep(500); // Delay between different users
  }
  
  return totalCreated;
}

function groupTweetsIntoRequests(tweets) {
  const requests = [];
  let current = { tweets: [], blocks: [] };

  for (const tweet of tweets) {
    const blocks = buildTweetBlocks(tweet);

    if (current.blocks.length > 0 && current.blocks.length + blocks.length > CONFIG.MAX_BLOCKS_PER_REQUEST) {
      requests.push(current);
      current = { tweets: [], blocks: [] };
    }

    current.tweets.push(tweet);
    current.blocks.push(...blocks);
  }

  if (current.blocks.length > 0) {
    requests.push(current);
  }

  return requests;
}

/**
 * Add tweets as content blocks to a parent page, never splitting a tweet across requests
 * @param {string} parentId - ID of the parent page
 * @param {Array} tweets - Array of tweet bookmark objects
 * @returns {Array} Raindrop IDs of the tweets that were actually added
 */
function addTweetsToParentPage(parentId, tweets) {
  const existingIds = new Set(getTwitterChildBlocksWithRaindropIds(parentId).map(t => t.raindropId));
  const newTweets = tweets.filter(tweet => !existingIds.has(tweet._id.toString()));

  if (newTweets.length === 0) {
    Logger.log(`  ℹ️ All ${tweets.length} tweets already exist in parent page, skipping...`);
    return [];
  }

  if (newTweets.length < tweets.length) {
    Logger.log(`  ℹ️ Skipping ${tweets.length - newTweets.length} existing tweets, adding ${newTweets.length} new tweets...`);
  }

  const addedIds = [];

  for (const request of groupTweetsIntoRequests(newTweets)) {
    try {
      notionRequest('patch', `/blocks/${parentId}/children`, { children: request.blocks }, { idempotent: false });
    } catch (error) {
      logError('ERROR', `Failed to add ${request.tweets.length} tweets to parent page`, {
        parentId: parentId,
        error: error.message
      });
      break;
    }

    request.tweets.forEach(tweet => addedIds.push(tweet._id.toString()));
    Utilities.sleep(300);
  }

  if (addedIds.length > 0) {
    Logger.log(`✓ Added ${addedIds.length} new tweets to parent page`);
    const latestTweet = [...tweets].sort((a, b) => new Date(b.created) - new Date(a.created))[0];
    updateParentPageDateSaved(parentId, latestTweet.created);
  }

  return addedIds;
}

/**
 * Update the Date Saved property of a parent page to reflect the latest tweet
 * @param {string} pageId - ID of the parent page to update
 * @param {string} dateString - ISO date string of the latest tweet
 */
function updateParentPageDateSaved(pageId, dateString) {
  try {
    notionRequest('patch', `/pages/${pageId}`, { properties: { 'Date Saved': dateProperty(dateString) } });
    Logger.log(`  ✓ Updated parent page Date Saved to ${formatDate(dateString)}`);
  } catch (error) {
    Logger.log(`  ⚠️ Warning: Could not update Date Saved: ${error.message}`);
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Confirm if this is the first run by checking if database is empty
 * @returns {boolean} True if this appears to be the first sync run
 */
function confirmFirstRun() {
  try {
    const data = notionRequest('post', `/databases/${CONFIG.NOTION_DATABASE_ID}/query`, { page_size: 1 });
    const isEmpty = !data.results || data.results.length === 0;

    if (isEmpty) {
      Logger.log('✓ Database appears to be empty - confirming first run');
      return true;
    }

    Logger.log('⚠️ Database contains pages but no Raindrop IDs found');
    return false;

  } catch (error) {
    Logger.log(`Warning: Error checking first run status: ${error.message}`);
    return false; // Err on side of caution to prevent duplicates
  }
}

/**
 * Validate that all required configuration is properly set
 * Prevents running with placeholder values that would cause immediate failures
 */
function validateConfiguration(keys = ['RAINDROP_API_TOKEN', 'NOTION_API_TOKEN', 'NOTION_DATABASE_ID']) {
  Logger.log('Validating configuration...');

  const errors = [];

  for (const key of keys) {
    const value = CONFIG[key];
    if (typeof value !== 'string' || value.includes('YOUR_') || value.includes('_HERE') || value.length < 10) {
      errors.push(`${key} is not configured (contains placeholder or is too short)`);
    }
  }

  if (errors.length > 0) {
    errors.forEach(message => Logger.log(`❌ ${message}`));
    throw new Error(`Invalid configuration: ${errors.join('; ')}`);
  }
}

const TWITTER_HOST_BOUNDARY = /^https?:\/\/(?:(?:www|mobile|m)\.)?(?:twitter\.com|x\.com)(?:[\/?#:]|$)/i;
const TWITTER_HANDLE_PATTERN = /^https?:\/\/(?:(?:www|mobile|m)\.)?(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]+)/i;
const TWITTER_RESERVED_PATHS = ['home', 'explore', 'notifications', 'messages', 'i', 'search'];

function isTwitterUrl(url) {
  return typeof url === 'string' && TWITTER_HOST_BOUNDARY.test(url.trim());
}

/**
 * Extract Twitter handle from URL
 * @param {string} url - Twitter URL
 * @returns {string} Twitter handle without @ symbol, or null
 */
function extractTwitterHandle(url) {
  if (!isTwitterUrl(url)) return null;

  const match = url.trim().match(TWITTER_HANDLE_PATTERN);
  if (!match) return null;

  const username = match[1].toLowerCase();
  return TWITTER_RESERVED_PATHS.includes(username) ? null : username;
}

/**
 * Log an error for tracking
 * @param {string} type - Error type (ERROR, WARNING, INFO)
 * @param {string} message - Error message
 * @param {Object} details - Additional details
 */
function logError(type, message, details = {}) {
  const errorEntry = {
    type: type,
    message: message,
    details: details,
    timestamp: new Date().toISOString()
  };
  
  if (type === 'ERROR' || type === 'CRITICAL') {
    syncErrors.push(errorEntry);
  } else if (type === 'WARNING') {
    syncWarnings.push(errorEntry);
  }
  
  Logger.log(`${type === 'ERROR' || type === 'CRITICAL' ? '❌' : '⚠️'} ${type}: ${message}`);
}

// ============================================================================
// NOTION DATABASE SCHEMA HELPERS
// ============================================================================

let _cachedDbTitlePropName = null;

/**
 * Determine the database title property name (e.g., 'Name', 'Title', etc.)
 * @returns {string}
 */
function getDatabaseTitlePropertyName() {
  if (_cachedDbTitlePropName) return _cachedDbTitlePropName;
  const db = notionRequest('get', `/databases/${CONFIG.NOTION_DATABASE_ID}`);
  const props = db.properties || {};
  for (const key in props) {
    if (props[key]?.type === 'title') {
      _cachedDbTitlePropName = key;
      return key;
    }
  }
  throw new Error('No title property found in Notion database');
}

/**
 * Enrich Raindrop bookmarks with derived metadata
 * - collectionName using cached collection titles
 * - type override to 'tweet' for Twitter URLs
 * - ensure tags array exists
 */
const _collectionTitleCache = {};
function enrichBookmarksMetadata(bookmarks) {
  for (const b of bookmarks) {
    // Collection name
    let colName = 'Unsorted';
    try {
      const colId = (b.collection && (b.collection.$id || b.collection.id)) || b.collectionId || 0;
      if (colId && _collectionTitleCache[colId]) {
        colName = _collectionTitleCache[colId];
      } else if (b.collection && b.collection.title) {
        colName = b.collection.title;
        if (colId) _collectionTitleCache[colId] = colName;
      } else if (colId) {
        const col = fetchRaindropCollection(colId);
        if (col && col.title) {
          colName = col.title;
          _collectionTitleCache[colId] = colName;
        }
      }
    } catch (e) {
      // keep default
    }
    b.collectionName = colName || 'Unsorted';

    // Tags ensure array
    if (!Array.isArray(b.tags)) b.tags = (b.tags && typeof b.tags === 'object' && b.tags.name) ? [b.tags.name] : [];

    // Type override for Twitter - only override collection if it's already "Twitter"
    // Don't override if the bookmark is saved to a different collection (like "Articles")
    if (isTwitterUrl(b.link)) {
      b.type = 'tweet';
      // Only set collection to "Twitter" if it's already "Twitter" or "Unsorted"
      // This preserves intentional collection choices like "Articles"
      if (b.collectionName === 'Twitter' || b.collectionName === 'Unsorted') {
        b.collectionName = 'Twitter';
      }
    }
  }
}


// ============================================================================
// TRIGGER MANAGEMENT
// ============================================================================

/**
 * Delete all existing triggers for this script
 * Use this if you need to clean up or reconfigure
 */
function deleteAllTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  let count = 0;
  
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === CONFIG.TRIGGER_FUNCTION_NAME) {
      ScriptApp.deleteTrigger(trigger);
      count++;
    }
  });
  
  Logger.log(`✓ Deleted ${count} trigger(s)`);
}

/**
 * List all triggers for this script
 */
function listTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  const relevantTriggers = triggers.filter(t => 
    t.getHandlerFunction() === CONFIG.TRIGGER_FUNCTION_NAME
  );
  
  if (relevantTriggers.length === 0) {
    Logger.log('No triggers found for this script');
    return;
  }
  
  Logger.log(`Found ${relevantTriggers.length} trigger(s):`);
  relevantTriggers.forEach(trigger => {
    Logger.log(`- ${trigger.getHandlerFunction()} (${trigger.getEventType()})`);
  });
}

/**
 * Format hour in 12-hour format
 * @param {number} hour - Hour in 24-hour format
 * @returns {string} Formatted time
 */
function formatHour(hour) {
  if (hour === 0) return '12:00 AM';
  if (hour === 12) return '12:00 PM';
  if (hour < 12) return `${hour}:00 AM`;
  return `${hour - 12}:00 PM`;
}

/**
 * Format date to a more readable format (YYYY-MM-DD HH:MM)
 * @param {string} dateString - ISO date string
 * @returns {string} Formatted date
 */
function formatDate(dateString) {
  if (!dateString) return 'Unknown';
  try {
    const date = new Date(dateString);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  } catch (error) {
    return 'Unknown';
  }
}