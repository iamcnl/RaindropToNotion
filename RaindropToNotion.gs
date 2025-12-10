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
  
  // Script execution limits (Google Apps Script has 6 min execution limit)
  MAX_EXECUTION_TIME: 5.5 * 60 * 1000, // 5.5 minutes in milliseconds
  
  // Trigger settings
  TRIGGER_HOUR: 20, // 8:00 PM (24-hour format)
  TRIGGER_FUNCTION_NAME: 'syncRaindropToNotion',

};


// ============================================================================
// MAIN FUNCTIONS
// ============================================================================


// Error tracking for logging
let syncErrors = [];
let syncWarnings = [];


function setupDatabaseProperties() {
  Logger.log('Setting up Notion database properties...');
  
  const url = `${CONFIG.NOTION_API_BASE}/databases/${CONFIG.NOTION_DATABASE_ID}`;
  
  // Do not attempt to create/rename the title property. We'll use whatever the DB already has.
  // Only ensure our custom properties exist.
  const properties = {
    'Raindrop ID': {
      rich_text: {}
    },
    'URL': {
      url: {}
    },
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
    'Collection': {
      select: {}
    },
    'Tags': {
      multi_select: {}
    },
    'Date Saved': {
      date: {}
    }
  };
  
  const payload = {
    properties: properties
  };
  
  const options = {
    method: 'patch',
    headers: {
      'Authorization': `Bearer ${CONFIG.NOTION_API_TOKEN}`,
      'Notion-Version': CONFIG.NOTION_API_VERSION,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  
  try {
    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();
    
    if (code === 200) {
      Logger.log('✓ Database properties configured successfully');
      return true;
    } else {
      Logger.log(`❌ Error: ${code} - ${response.getContentText()}`);
      return false;
    }
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
    let page = 0;
    let totalProcessed = 0;
    let totalSkipped = 0;
    let totalCreated = 0;
    let totalUpdated = 0;
    let hasMore = true;
    
    while (hasMore) {
      // Check execution time limit
      const elapsed = new Date().getTime() - startTime;
      if (elapsed > CONFIG.MAX_EXECUTION_TIME) {
        Logger.log(`⚠️ Approaching execution time limit. Processed ${totalProcessed} bookmarks.`);
        Logger.log('Script will resume on next trigger.');
        break;
      }
      
      // Fetch a page of bookmarks
      const response = fetchRaindropBookmarks(page);
      if (!response || !response.items || response.items.length === 0) {
        hasMore = false;
        break;
      }
      
  const bookmarks = response.items;
  // Enrich bookmarks with derived metadata (collection name, type, tags)
  enrichBookmarksMetadata(bookmarks);
      Logger.log(`\nProcessing page ${page}: ${bookmarks.length} bookmarks`);
      
      // Separate bookmarks into new, existing, and to-update
      const newBookmarks = [];
      const existingBookmarks = [];
      
      for (const bookmark of bookmarks) {
        const raindropId = bookmark._id.toString();
        if (!existingIds.has(raindropId)) {
          newBookmarks.push(bookmark);
        } else {
          existingBookmarks.push(bookmark);
        }
      }
      
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
          hasMore = false;
          break;
        }
      } else if (existingBookmarks.length > 0 && !CONFIG.ENABLE_UPDATE_CHECK) {
        Logger.log(`Update check is disabled, skipping ${existingBookmarks.length} existing bookmarks`);
      }
      
      if (newBookmarks.length > 0) {
        // Separate Twitter and non-Twitter bookmarks
        // Only treat as Twitter bookmark if it's in the "Twitter" collection AND Twitter organization is enabled
        // Articles from Twitter should be treated as regular bookmarks
        const twitterBookmarks = [];
        const regularBookmarks = [];
        
        for (const bookmark of newBookmarks) {
          // Only use Twitter processing if:
          // 1. Twitter organization is enabled
          // 2. URL is from Twitter
          // 3. Collection is "Twitter" or "Unsorted"
          if (CONFIG.ENABLE_TWITTER_ORGANIZATION &&
              isTwitterUrl(bookmark.link) && 
              (bookmark.collectionName === 'Twitter' || bookmark.collectionName === 'Unsorted')) {
            twitterBookmarks.push(bookmark);
          } else {
            regularBookmarks.push(bookmark);
          }
        }
        
        // Process Twitter bookmarks (with parent pages)
        if (twitterBookmarks.length > 0) {
          Logger.log(`Processing ${twitterBookmarks.length} Twitter bookmarks...`);
          const created = processTwitterBookmarks(twitterBookmarks, twitterParents, existingIds);
          totalCreated += created;
        }
        
        // Process regular bookmarks in batches
        if (regularBookmarks.length > 0) {
          Logger.log(`Processing ${regularBookmarks.length} regular bookmarks...`);
          const created = processBatchBookmarks(regularBookmarks, null, existingIds);
          totalCreated += created;
        }
      }
      
      totalProcessed += bookmarks.length;
      
      // Check if there are more pages
      hasMore = response.items.length >= CONFIG.RAINDROP_PAGE_SIZE;
      page++;
      
      // Delay between pages to avoid rate limits
      if (hasMore) {
        Utilities.sleep(CONFIG.DELAY_BETWEEN_BATCHES);
      }
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

// ============================================================================
// RAINDROP.IO API FUNCTIONS
// ============================================================================

/**
 * Fetch bookmarks from Raindrop.io with pagination
 * @param {number} page - Page number (0-indexed)
 * @returns {Object} Response with items array
 */
function fetchRaindropBookmarks(page = 0) {
  const url = `${CONFIG.RAINDROP_API_BASE}/raindrops/0?perpage=${CONFIG.RAINDROP_PAGE_SIZE}&page=${page}&sort=-created`;
  
  const options = {
    method: 'get',
    headers: {
      'Authorization': `Bearer ${CONFIG.RAINDROP_API_TOKEN}`
    },
    muteHttpExceptions: true
  };
  
  return makeRequestWithRetry(() => {
    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();
    
    if (code === 429) {
      Logger.log('⚠️ Rate limited by Raindrop API, waiting...');
      Utilities.sleep(CONFIG.DELAY_ON_RATE_LIMIT);
      throw new Error('Rate limited');
    }
    
    if (code !== 200) {
      throw new Error(`Raindrop API error: ${code} - ${response.getContentText()}`);
    }
    
    return JSON.parse(response.getContentText());
  });
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
  
  const url = `${CONFIG.RAINDROP_API_BASE}/collection/${collectionId}`;
  
  const options = {
    method: 'get',
    headers: {
      'Authorization': `Bearer ${CONFIG.RAINDROP_API_TOKEN}`
    },
    muteHttpExceptions: true
  };
  
  return makeRequestWithRetry(() => {
    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();
    
    if (code === 200) {
      const data = JSON.parse(response.getContentText());
      return data.item;
    }
    
    return { title: 'Unknown Collection' };
  });
}

// ============================================================================
// NOTION API FUNCTIONS
// ============================================================================

/**
 * Query Notion database to get existing Raindrop IDs with their Notion page IDs
 * Also checks Twitter parent pages for child pages containing Raindrop IDs
 * @returns {Object} Object with two properties:
 *   - idSet: Set of existing Raindrop IDs
 *   - idToPageMap: Map of Raindrop ID -> {notionPageId, lastEditedTime, isTwitterChild}
 */
function getExistingRaindropIds() {
  const existingIds = new Set();
  const idToPageMap = new Map(); // Map Raindrop ID to Notion page info
  let hasMore = true;
  let startCursor = undefined;
  let retryCount = 0;
  const maxRetries = 3;
  
  // First, get IDs from database items
  while (hasMore) {
    const url = `${CONFIG.NOTION_API_BASE}/databases/${CONFIG.NOTION_DATABASE_ID}/query`;
    
    const payload = {
      page_size: 100
    };
    
    if (startCursor) {
      payload.start_cursor = startCursor;
    }
    
    const options = {
      method: 'post',
      headers: {
        'Authorization': `Bearer ${CONFIG.NOTION_API_TOKEN}`,
        'Notion-Version': CONFIG.NOTION_API_VERSION,
        'Content-Type': 'application/json'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };
    
    try {
      const response = UrlFetchApp.fetch(url, options);
      const responseCode = response.getResponseCode();
      
      // Handle transient errors with retry
      if (responseCode !== 200 && retryCount < maxRetries) {
        retryCount++;
        Logger.log(`⚠️ Error fetching existing IDs (${responseCode}), retry ${retryCount}/${maxRetries} in 3 seconds...`);
        Utilities.sleep(3000);
        continue; // Retry the same request
      }
      
      if (responseCode !== 200) {
        throw new Error(`Failed after ${maxRetries} retries: ${response.getContentText()}`);
      }
      
      // Reset retry count on success
      retryCount = 0;
      
      const data = JSON.parse(response.getContentText());
      
      if (data.results) {
        data.results.forEach(page => {
          // Get Raindrop IDs from database items
          if (page.properties && page.properties['Raindrop ID']) {
            const raindropId = page.properties['Raindrop ID'].rich_text?.[0]?.plain_text;
            if (raindropId) {
              existingIds.add(raindropId);
              idToPageMap.set(raindropId, {
                notionPageId: page.id,
                lastEditedTime: page.last_edited_time,
                isTwitterChild: false
              });
            }
          }
          
          // Check if this is a Twitter parent page, and scan its children
          if (page.properties && page.properties['Type'] && 
              page.properties['Type'].select?.name === 'tweets') {
            try {
              const childInfo = getTwitterChildrenRaindropIds(page.id);
              childInfo.forEach(info => {
                existingIds.add(info.raindropId);
                idToPageMap.set(info.raindropId, {
                  notionPageId: page.id, // Store parent page ID for Twitter children
                  lastEditedTime: page.last_edited_time,
                  isTwitterChild: true,
                  blockIds: info.blockIds
                });
              });
            } catch (error) {
              Logger.log(`Warning: Error checking children of ${page.id}: ${error.message}`);
            }
          }
        });
      }
      
      hasMore = data.has_more;
      startCursor = data.next_cursor;
      
    } catch (error) {
      // Critical error - we need existing IDs to avoid duplicates
      if (retryCount < maxRetries) {
        retryCount++;
        Logger.log(`❌ Error fetching existing IDs: ${error.message}`);
        Logger.log(`⚠️ Retrying (${retryCount}/${maxRetries}) in 5 seconds...`);
        Utilities.sleep(5000);
        continue; // Retry
      } else {
        Logger.log(`❌ CRITICAL: Failed to fetch existing IDs after ${maxRetries} retries`);
        Logger.log(`❌ This would create massive duplicates - ABORTING IMMEDIATELY`);
        // Don't return empty set - throw error to prevent duplicate creation
        throw new Error(`DUPLICATE PREVENTION: Cannot proceed without existing IDs: ${error.message}`);
      }
    }
    
    if (hasMore) {
      Utilities.sleep(300); // Small delay between pagination requests
    }
  }
  
  return { idSet: existingIds, idToPageMap: idToPageMap };
}

/**
 * Get Raindrop IDs from child pages of a Twitter parent page
 * Now searches content blocks within the parent page for embedded Raindrop IDs
 * Returns the IDs with block information
 * @param {string} parentPageId - ID of the Twitter parent page
 * @returns {Array} Array of objects with {raindropId, blockIds: [array of block IDs]}
 */
function getTwitterChildrenRaindropIds(parentPageId) {
  return getTwitterChildBlocksWithRaindropIds(parentPageId);
}

/**
 * Get the text content of a page
 * @param {string} pageId - ID of the page
 * @returns {string} Text content of the page
 */
function getPageContent(pageId) {
  const url = `${CONFIG.NOTION_API_BASE}/blocks/${pageId}/children`;
  
  const options = {
    method: 'get',
    headers: {
      'Authorization': `Bearer ${CONFIG.NOTION_API_TOKEN}`,
      'Notion-Version': CONFIG.NOTION_API_VERSION
    },
    muteHttpExceptions: true
  };
  
  const response = UrlFetchApp.fetch(url, options);
  const data = JSON.parse(response.getContentText());
  
  let content = '';
  if (data.results) {
    data.results.forEach(block => {
      if (block.type === 'paragraph' && block.paragraph && block.paragraph.rich_text) {
        block.paragraph.rich_text.forEach(text => {
          if (text.plain_text) {
            content += text.plain_text + ' ';
          }
        });
      }
    });
  }
  
  return content;
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
    // Find all Twitter parent pages
    const url = `${CONFIG.NOTION_API_BASE}/databases/${CONFIG.NOTION_DATABASE_ID}/query`;
    const titleProp = getDatabaseTitlePropertyName();
    const payload = {
      filter: {
        property: 'Type',
        select: { equals: 'tweets' }
      },
      page_size: 100
    };
    
    const options = {
      method: 'post',
      headers: {
        'Authorization': `Bearer ${CONFIG.NOTION_API_TOKEN}`,
        'Notion-Version': CONFIG.NOTION_API_VERSION,
        'Content-Type': 'application/json'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };
    
    let hasMore = true;
    let startCursor = undefined;
    let totalDeletedTweets = 0;
    let totalDeletedBlocks = 0;
    const emptyParents = []; // Track parents that become empty
    
    while (hasMore) {
      if (startCursor) {
        payload.start_cursor = startCursor;
      }
      
      const response = UrlFetchApp.fetch(url, {
        ...options,
        payload: JSON.stringify(payload)
      });
      
      const data = JSON.parse(response.getContentText());
      
      if (data.results) {
        for (const page of data.results) {
          const parentTitle = page.properties[titleProp]?.title?.[0]?.plain_text || 'Unknown';
          const tweets = getTwitterChildBlocksWithRaindropIds(page.id);
          
          // Find tweets to delete
          const tweetsToDelete = tweets.filter(tweet => 
            !currentRaindropIds.has(tweet.raindropId)
          );
          
          if (tweetsToDelete.length > 0) {
            Logger.log(`Found ${tweetsToDelete.length} deleted tweet(s) in ${parentTitle}`);
            
            for (const tweet of tweetsToDelete) {
              try {
                // Delete all blocks associated with this tweet
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
              } catch (error) {
                Logger.log(`  ❌ Failed to delete tweet ${tweet.raindropId}: ${error.message}`);
              }
            }
            
            // Check if all tweets were deleted from this parent
            if (tweetsToDelete.length === tweets.length) {
              emptyParents.push({
                id: page.id,
                title: parentTitle
              });
            }
          }
        }
      }
      
      hasMore = data.has_more;
      startCursor = data.next_cursor;
      
      if (hasMore) {
        Utilities.sleep(300);
      }
    }
    
    // Report results
    if (totalDeletedTweets > 0) {
      Logger.log(`\n✓ Deleted ${totalDeletedTweets} tweet(s) (${totalDeletedBlocks} blocks) from parent pages`);
    } else {
      Logger.log('✓ No deleted tweets found in parent pages');
    }
    
    // Delete empty parent pages
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
 * Get all current Raindrop bookmark IDs
 * @returns {Set} Set of all current Raindrop IDs
 */
function getAllRaindropIds() {
  const raindropIds = new Set();
  let page = 0;
  let hasMore = true;
  
  while (hasMore) {
    try {
      const response = fetchRaindropBookmarks(page);
      
      if (!response || !response.items || response.items.length === 0) {
        hasMore = false;
        break;
      }
      
      response.items.forEach(bookmark => {
        if (bookmark._id) {
          raindropIds.add(bookmark._id.toString());
        }
      });
      
      hasMore = response.items.length >= CONFIG.RAINDROP_PAGE_SIZE;
      page++;
      
      if (hasMore) {
        Utilities.sleep(300); // Small delay between pages
      }
    } catch (error) {
      Logger.log(`Warning: Error fetching Raindrop page ${page}: ${error.message}`);
      break;
    }
  }
  
  return raindropIds;
}

/**
 * Get all Notion pages with their Raindrop IDs
 * @returns {Array} Array of objects with {notionPageId, raindropId, title}
 */
function getAllNotionPagesWithRaindropIds() {
  const pages = [];
  let hasMore = true;
  let startCursor = undefined;
  const titleProp = getDatabaseTitlePropertyName();
  
  while (hasMore) {
    const url = `${CONFIG.NOTION_API_BASE}/databases/${CONFIG.NOTION_DATABASE_ID}/query`;
    
    const payload = {
      page_size: 100
    };
    
    if (startCursor) {
      payload.start_cursor = startCursor;
    }
    
    const options = {
      method: 'post',
      headers: {
        'Authorization': `Bearer ${CONFIG.NOTION_API_TOKEN}`,
        'Notion-Version': CONFIG.NOTION_API_VERSION,
        'Content-Type': 'application/json'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };
    
    try {
      const response = UrlFetchApp.fetch(url, options);
      const responseCode = response.getResponseCode();
      
      if (responseCode !== 200) {
        throw new Error(`Failed to fetch Notion pages: ${response.getContentText()}`);
      }
      
      const data = JSON.parse(response.getContentText());
      
      if (data.results) {
        data.results.forEach(page => {
          // Get Raindrop ID from page properties
          if (page.properties && page.properties['Raindrop ID']) {
            const raindropId = page.properties['Raindrop ID'].rich_text?.[0]?.plain_text;
            if (raindropId) {
              const title = page.properties[titleProp]?.title?.[0]?.plain_text || 'Untitled';
              pages.push({
                notionPageId: page.id,
                raindropId: raindropId,
                title: title,
                type: page.properties['Type']?.select?.name
              });
            }
          }
          
          // Note: Twitter parent pages and their tweet blocks are handled separately
          // in deleteRemovedTweetsFromParents() function
        });
      }
      
      hasMore = data.has_more;
      startCursor = data.next_cursor;
      
    } catch (error) {
      Logger.log(`❌ Error fetching Notion pages: ${error.message}`);
      break;
    }
    
    if (hasMore) {
      Utilities.sleep(300);
    }
  }
  
  return pages;
}

/**
 * Get Twitter child blocks with their Raindrop IDs from a parent page
 * Returns blocks grouped by tweet with all related blocks (content, metadata, link, spacing)
 * @param {string} parentPageId - ID of the Twitter parent page
 * @returns {Array} Array of objects with {raindropId, blockIds: [array of block IDs to delete]}
 */
function getTwitterChildBlocksWithRaindropIds(parentPageId) {
  const tweets = [];
  let hasMore = true;
  let startCursor = undefined;
  
  while (hasMore) {
    const url = `${CONFIG.NOTION_API_BASE}/blocks/${parentPageId}/children`;
    const fullUrl = startCursor ? `${url}?start_cursor=${startCursor}&page_size=100` : `${url}?page_size=100`;
    
    const options = {
      method: 'get',
      headers: {
        'Authorization': `Bearer ${CONFIG.NOTION_API_TOKEN}`,
        'Notion-Version': CONFIG.NOTION_API_VERSION
      },
      muteHttpExceptions: true
    };
    
    try {
      const response = UrlFetchApp.fetch(fullUrl, options);
      const responseCode = response.getResponseCode();
      
      // Check if the request was successful
      if (responseCode !== 200) {
        Logger.log(`Warning: Error fetching blocks from ${parentPageId}: ${response.getContentText()}`);
        break;
      }
      
      const data = JSON.parse(response.getContentText());
      
      if (data.results) {
        const allBlocks = data.results;
        
        // Find blocks with Raindrop IDs and collect all related blocks for each tweet
        for (let i = 0; i < allBlocks.length; i++) {
          const block = allBlocks[i];
          
          // Check if this block contains a Raindrop ID
          if (block.type === 'paragraph' && block.paragraph && block.paragraph.rich_text) {
            const text = block.paragraph.rich_text.map(t => t.plain_text).join('');
            const raindropIdMatch = text.match(/🆔 Raindrop ID: (\w+)/);
            
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
                  if (prevText.includes('🆔 Raindrop ID:') || 
                      prevText.includes('twitter.com') || 
                      prevText.includes('x.com')) {
                    break;
                  }
                  
                  // This is content, add it
                  blockIds.unshift(prevBlock.id); // Add to beginning
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
      }
      
      hasMore = data.has_more;
      startCursor = data.next_cursor;
      
    } catch (error) {
      Logger.log(`Warning: Error fetching blocks from ${parentPageId}: ${error.message}`);
      break;
    }
    
    if (hasMore) {
      Utilities.sleep(200);
    }
  }
  
  return tweets;
}

/**
 * Delete a Notion page by archiving it
 * @param {string} pageId - ID of the page to delete
 */
function deleteNotionPage(pageId) {
  const url = `${CONFIG.NOTION_API_BASE}/pages/${pageId}`;
  
  const payload = {
    archived: true
  };
  
  const options = {
    method: 'patch',
    headers: {
      'Authorization': `Bearer ${CONFIG.NOTION_API_TOKEN}`,
      'Notion-Version': CONFIG.NOTION_API_VERSION,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  
  return makeRequestWithRetry(() => {
    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();
    
    if (code === 429) {
      Logger.log('⚠️ Rate limited by Notion API, waiting...');
      Utilities.sleep(CONFIG.DELAY_ON_RATE_LIMIT);
      throw new Error('Rate limited');
    }
    
    if (code !== 200) {
      throw new Error(`Notion API error: ${code} - ${response.getContentText()}`);
    }
    
    return JSON.parse(response.getContentText());
  });
}

/**
 * Delete a Notion block
 * @param {string} blockId - ID of the block to delete
 */
function deleteNotionBlock(blockId) {
  const url = `${CONFIG.NOTION_API_BASE}/blocks/${blockId}`;
  
  const options = {
    method: 'delete',
    headers: {
      'Authorization': `Bearer ${CONFIG.NOTION_API_TOKEN}`,
      'Notion-Version': CONFIG.NOTION_API_VERSION
    },
    muteHttpExceptions: true
  };
  
  return makeRequestWithRetry(() => {
    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();
    
    if (code === 429) {
      Logger.log('⚠️ Rate limited by Notion API, waiting...');
      Utilities.sleep(CONFIG.DELAY_ON_RATE_LIMIT);
      throw new Error('Rate limited');
    }
    
    if (code !== 200) {
      throw new Error(`Notion API error: ${code} - ${response.getContentText()}`);
    }
    
    return JSON.parse(response.getContentText());
  });
}

/**
 * Update an existing Notion page with bookmark data
 * @param {string} pageId - Notion page ID to update
 * @param {Object} bookmark - Raindrop bookmark object with updated data
 * @returns {Object} Updated page response
 */
function updateNotionPage(pageId, bookmark) {
  const url = `${CONFIG.NOTION_API_BASE}/pages/${pageId}`;
  
  const titleProp = getDatabaseTitlePropertyName();
  const properties = {
    [titleProp]: {
      title: [
        {
          text: {
            content: bookmark.title || bookmark.link
          }
        }
      ]
    },
    'Type': {
      select: {
        name: bookmark.type || 'link'
      }
    },
    'Collection': {
      select: {
        name: bookmark.collectionName || 'Unsorted'
      }
    }
  };
  
  // Add tags if present
  if (bookmark.tags && bookmark.tags.length > 0) {
    properties['Tags'] = {
      multi_select: bookmark.tags.map(tag => ({ name: tag }))
    };
  } else {
    // Clear tags if none present
    properties['Tags'] = {
      multi_select: []
    };
  }
  
  const payload = {
    properties: properties
  };
  
  // Add cover image if present and enabled
  if (CONFIG.ENABLE_COVERS && bookmark.cover) {
    // Handle both string URLs and object formats
    const coverUrl = typeof bookmark.cover === 'string' ? bookmark.cover : bookmark.cover?.url;
    if (coverUrl) {
      payload.cover = {
        type: 'external',
        external: {
          url: coverUrl
        }
      };
    }
  }
  
  // Add icon if enabled (separate from cover)
  if (CONFIG.ENABLE_ICONS && bookmark.cover) {
    const coverUrl = typeof bookmark.cover === 'string' ? bookmark.cover : bookmark.cover?.url;
    if (coverUrl) {
      payload.icon = {
        type: 'external',
        external: {
          url: coverUrl
        }
      };
    }
  }
  
  const options = {
    method: 'patch',
    headers: {
      'Authorization': `Bearer ${CONFIG.NOTION_API_TOKEN}`,
      'Notion-Version': CONFIG.NOTION_API_VERSION,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  
  return makeRequestWithRetry(() => {
    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();
    
    if (code === 429) {
      Logger.log('⚠️ Rate limited by Notion API, waiting...');
      Utilities.sleep(CONFIG.DELAY_ON_RATE_LIMIT);
      throw new Error('Rate limited');
    }
    
    if (code !== 200) {
      throw new Error(`Notion API error: ${code} - ${response.getContentText()}`);
    }
    
    return JSON.parse(response.getContentText());
  });
}

/**
 * Update the content (note/excerpt) of a Notion page
 * @param {string} pageId - Notion page ID
 * @param {string} content - New content to set
 */
function updateNotionPageContent(pageId, content) {
  if (!content) return;
  
  try {
    // First, get existing blocks
    const blocksUrl = `${CONFIG.NOTION_API_BASE}/blocks/${pageId}/children`;
    const getOptions = {
      method: 'get',
      headers: {
        'Authorization': `Bearer ${CONFIG.NOTION_API_TOKEN}`,
        'Notion-Version': CONFIG.NOTION_API_VERSION
      },
      muteHttpExceptions: true
    };
    
    const getResponse = UrlFetchApp.fetch(blocksUrl, getOptions);
    const existingBlocks = JSON.parse(getResponse.getContentText());
    
    // Delete existing content blocks (paragraphs)
    if (existingBlocks.results) {
      for (const block of existingBlocks.results) {
        if (block.type === 'paragraph') {
          try {
            deleteNotionBlock(block.id);
            Utilities.sleep(100);
          } catch (error) {
            Logger.log(`Warning: Could not delete block ${block.id}: ${error.message}`);
          }
        }
      }
    }
    
    // Add new content
    const addOptions = {
      method: 'patch',
      headers: {
        'Authorization': `Bearer ${CONFIG.NOTION_API_TOKEN}`,
        'Notion-Version': CONFIG.NOTION_API_VERSION,
        'Content-Type': 'application/json'
      },
      payload: JSON.stringify({
        children: [
          {
            object: 'block',
            type: 'paragraph',
            paragraph: {
              rich_text: [
                {
                  type: 'text',
                  text: {
                    content: content
                  }
                }
              ]
            }
          }
        ]
      }),
      muteHttpExceptions: true
    };
    
    UrlFetchApp.fetch(blocksUrl, addOptions);
  } catch (error) {
    Logger.log(`Warning: Could not update page content: ${error.message}`);
  }
}

/**
 * Create a page in Notion database
 * @param {Object} bookmark - Raindrop bookmark object
 * @param {string} parentId - Optional parent page ID (not used for Twitter anymore)
 * @returns {Object} Created page response
 */
function createNotionPage(bookmark, parentId = null) {
  // Only throw error for Twitter bookmarks that should be in Twitter collection
  // AND when Twitter organization is enabled
  // Allow Twitter URLs from other collections (like Articles) to be created as regular pages
  // Also allow Twitter bookmarks when Twitter organization is disabled
  if (CONFIG.ENABLE_TWITTER_ORGANIZATION &&
      isTwitterUrl(bookmark.link) && 
      (bookmark.collectionName === 'Twitter' || bookmark.collectionName === 'Unsorted')) {
    throw new Error('Twitter bookmarks in Twitter collection should be handled by addTweetsToParentPage function');
  }
  
  const url = `${CONFIG.NOTION_API_BASE}/pages`;
  
  // Prepare the page properties for database items
  const titleProp = getDatabaseTitlePropertyName();
  const properties = {
    [titleProp]: {
      title: [
        {
          text: {
            content: bookmark.title || bookmark.link
          }
        }
      ]
    },
    'Raindrop ID': {
      rich_text: [
        {
          text: {
            content: bookmark._id.toString()
          }
        }
      ]
    },
    'URL': {
      url: bookmark.link
    },
    'Type': {
      select: {
        name: bookmark.type || 'link'
      }
    },
    'Collection': {
      select: {
        name: bookmark.collectionName || 'Unsorted'
      }
    },
    'Date Saved': {
      date: {
        start: bookmark.created
      }
    }
  };
  
  // Add tags if present
  if (bookmark.tags && bookmark.tags.length > 0) {
    properties['Tags'] = {
      multi_select: bookmark.tags.map(tag => ({ name: tag }))
    };
  }
  
  // Create as database item
  const pageData = {
    parent: { database_id: CONFIG.NOTION_DATABASE_ID },
    properties: properties
  };
  
  // Add cover image if present and enabled
  if (CONFIG.ENABLE_COVERS && bookmark.cover) {
    // Handle both string URLs and object formats
    const coverUrl = typeof bookmark.cover === 'string' ? bookmark.cover : bookmark.cover?.url;
    if (coverUrl) {
      pageData.cover = {
        type: 'external',
        external: {
          url: coverUrl
        }
      };
    }
  }
  
  // Add icon if enabled (separate from cover)
  if (CONFIG.ENABLE_ICONS && bookmark.cover) {
    const coverUrl = typeof bookmark.cover === 'string' ? bookmark.cover : bookmark.cover?.url;
    if (coverUrl) {
      pageData.icon = {
        type: 'external',
        external: {
          url: coverUrl
        }
      };
    }
  }
  
  // Add note/excerpt as page content if present and enabled
  if (CONFIG.ENABLE_PAGE_CONTENT && (bookmark.excerpt || bookmark.note)) {
    pageData.children = [];
    
    // Add excerpt if present
    if (bookmark.excerpt) {
      pageData.children.push({
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [
            {
              type: 'text',
              text: {
                content: bookmark.excerpt
              }
            }
          ]
        }
      });
    }
    
    // Add note if present (in addition to excerpt) - as a quote block
    if (bookmark.note) {
      pageData.children.push({
        object: 'block',
        type: 'quote',
        quote: {
          rich_text: [
            {
              type: 'text',
              text: {
                content: bookmark.note
              }
            }
          ],
          color: 'default'
        }
      });
    }
  }
  
  const options = {
    method: 'post',
    headers: {
      'Authorization': `Bearer ${CONFIG.NOTION_API_TOKEN}`,
      'Notion-Version': CONFIG.NOTION_API_VERSION,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(pageData),
    muteHttpExceptions: true
  };
  
  return makeRequestWithRetry(() => {
    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();
    
    if (code === 429) {
      Logger.log('⚠️ Rate limited by Notion API, waiting...');
      Utilities.sleep(CONFIG.DELAY_ON_RATE_LIMIT);
      throw new Error('Rate limited');
    }
    
    if (code !== 200) {
      throw new Error(`Notion API error: ${code} - ${response.getContentText()}`);
    }
    
    return JSON.parse(response.getContentText());
  });
}

/**
 * Create a Twitter bookmark as a child page inside a Twitter parent page
 * @param {Object} bookmark - Raindrop bookmark object
 * @param {string} parentId - Parent page ID
 * @returns {Object} Created page response
 */
function createTwitterChildPage(bookmark, parentId) {
  const url = `${CONFIG.NOTION_API_BASE}/pages`;
  
  const pageData = {
    parent: { page_id: parentId },
    properties: {
      title: {
        title: [
          {
            text: {
              content: bookmark.title || bookmark.link
            }
          }
        ]
      }
    },
    children: [
      {
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [
            {
              type: 'text',
              text: {
                content: `🔗 `,
                link: null
              }
            },
            {
              type: 'text',
              text: {
                content: bookmark.link,
                link: { url: bookmark.link }
              }
            }
          ]
        }
      }
    ]
  };
  
  // Add cover image if present and enabled
  if (CONFIG.ENABLE_COVERS && bookmark.cover) {
    // Handle both string URLs and object formats
    const coverUrl = typeof bookmark.cover === 'string' ? bookmark.cover : bookmark.cover?.url;
    if (coverUrl) {
      pageData.cover = {
        type: 'external',
        external: {
          url: coverUrl
        }
      };
    }
  }
  
  // Add icon if enabled (separate from cover)
  if (CONFIG.ENABLE_ICONS && bookmark.cover) {
    const coverUrl = typeof bookmark.cover === 'string' ? bookmark.cover : bookmark.cover?.url;
    if (coverUrl) {
      pageData.icon = {
        type: 'external',
        external: {
          url: coverUrl
        }
      };
    }
  }
  
  // Add excerpt/note as additional content if present and enabled
  if (CONFIG.ENABLE_PAGE_CONTENT && (bookmark.excerpt || bookmark.note)) {
    const content = bookmark.excerpt || bookmark.note;
    pageData.children.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [
          {
            type: 'text',
            text: {
              content: content
            }
          }
        ]
      }
    });
  }
  
  // Add tags as a bulleted list if present
  if (bookmark.tags && bookmark.tags.length > 0) {
    pageData.children.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [
          {
            type: 'text',
            text: {
              content: `🏷️ Tags: ${bookmark.tags.join(', ')}`
            }
          }
        ]
      }
    });
  }
  
  // Add metadata
  pageData.children.push({
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [
        {
          type: 'text',
          text: {
            content: `📅 Saved: ${bookmark.created || 'Unknown'} | 📁 Collection: ${bookmark.collectionName || 'Unsorted'} | 🆔 Raindrop ID: ${bookmark._id}`
          }
        }
      ]
    }
  });
  
  const options = {
    method: 'post',
    headers: {
      'Authorization': `Bearer ${CONFIG.NOTION_API_TOKEN}`,
      'Notion-Version': CONFIG.NOTION_API_VERSION,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(pageData),
    muteHttpExceptions: true
  };
  
  return makeRequestWithRetry(() => {
    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();
    
    if (code === 429) {
      Logger.log('⚠️ Rate limited by Notion API, waiting...');
      Utilities.sleep(CONFIG.DELAY_ON_RATE_LIMIT);
      throw new Error('Rate limited');
    }
    
    if (code !== 200) {
      throw new Error(`Notion API error: ${code} - ${response.getContentText()}`);
    }
    
    return JSON.parse(response.getContentText());
  });
}

/**
 * Create multiple pages in Notion using batch API (via individual calls)
 * Note: Notion doesn't have a true batch create API, so we batch our calls
 * @param {Array} bookmarks - Array of bookmark objects
 * @param {string} parentId - Optional parent page ID
 * @returns {number} Number of successfully created pages
 */
function createNotionPagesBatch(bookmarks, parentId = null, existingIdsSet = null) {
  let successCount = 0;
  let failureCount = 0;
  
  for (let i = 0; i < bookmarks.length; i++) {
    try {
      const created = createNotionPage(bookmarks[i], parentId);
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
 * Get Twitter logo icon URL
 * Returns the official Twitter/X logo for consistent icons
 * @param {string} username - Twitter username (without @) - not used but kept for compatibility
 * @returns {string} Twitter logo URL
 */
function getTwitterProfilePicUrl(username) {
  // Use the official X (Twitter) logo
  // This is more reliable than trying to fetch individual profile pictures
  return 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png';
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
  const usernameOnly = username.startsWith('@') ? username.slice(1) : username;
  
  // Check cache first
  if (twitterParents[handle]) {
    return twitterParents[handle];
  }
  
  // Search for existing parent page
  const url = `${CONFIG.NOTION_API_BASE}/databases/${CONFIG.NOTION_DATABASE_ID}/query`;
  const titleProp = getDatabaseTitlePropertyName();
  
  const payload = {
    filter: {
      and: [
        {
          property: titleProp,
          title: { contains: handle }
        },
        {
          property: 'Type',
          select: { equals: 'tweets' }
        }
      ]
    }
  };
  
  const options = {
    method: 'post',
    headers: {
      'Authorization': `Bearer ${CONFIG.NOTION_API_TOKEN}`,
      'Notion-Version': CONFIG.NOTION_API_VERSION,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  
  // Try to find existing parent with retries
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = UrlFetchApp.fetch(url, options);
      const code = response.getResponseCode();
      
      if (code !== 200) {
        if (attempt < maxRetries - 1) {
          Logger.log(`  ⚠️ Search for "${handle}" failed (${code}), retry ${attempt + 1}/${maxRetries - 1} in 3 seconds...`);
          Utilities.sleep(3000);
          continue;
        } else {
          Logger.log(`  ❌ Failed to search for "${handle}" after ${maxRetries} attempts`);
          break; // Will create new parent page
        }
      }
      
      const data = JSON.parse(response.getContentText());
      
      if (data.results && data.results.length > 0) {
        // Filter results to find exact match (handle should match exactly)
        const exactMatch = data.results.find(page => {
          const pageTitle = page.properties[titleProp]?.title?.[0]?.plain_text || '';
          // Match either "@username on Twitter" or just "@username"
          return pageTitle === `${handle} on Twitter` || pageTitle === handle;
        });
        
        if (exactMatch) {
          const pageId = exactMatch.id;
          twitterParents[handle] = pageId;
          
          Logger.log(`  ✓ Found existing Twitter parent page for ${handle}`);
          
          // Update existing parent page with new tags if needed
          updateTwitterParentTags(pageId, allUserBookmarks);
          
          return pageId;
        } else {
          Logger.log(`  ℹ️ Found ${data.results.length} pages containing "${handle}" but none matched exactly`);
        }
      }
      
      // Successfully searched but no match found, break and create new
      break;
      
    } catch (error) {
      if (attempt < maxRetries - 1) {
        Logger.log(`  ⚠️ Error searching for "${handle}": ${error.message}, retrying...`);
        Utilities.sleep(3000);
      } else {
        Logger.log(`  ❌ Failed to search for "${handle}" after ${maxRetries} attempts: ${error.message}`);
      }
    }
  }
  
  // Collect all unique tags from user's bookmarks
  const allTags = new Set();
  allUserBookmarks.forEach(bookmark => {
    if (bookmark.tags && Array.isArray(bookmark.tags)) {
      bookmark.tags.forEach(tag => allTags.add(tag));
    }
  });
  
  // Create new parent page
  Logger.log(`Creating Twitter parent page: ${handle}`);
  
  const createUrl = `${CONFIG.NOTION_API_BASE}/pages`;
  const createPayload = {
    parent: {
      database_id: CONFIG.NOTION_DATABASE_ID
    },
    properties: {
      [titleProp]: {
        title: [
          {
            text: {
              content: `${handle} on Twitter`
            }
          }
        ]
      },
      'Type': {
        select: {
          name: 'tweets'
        }
      },
      'Collection': {
        select: {
          name: 'Twitter'
        }
      },
      'Date Saved': {
        date: {
          start: latestBookmark ? latestBookmark.created : new Date().toISOString()
        }
      }
    }
  };
  
  // Add tags if present
  if (allTags.size > 0) {
    createPayload.properties['Tags'] = {
      multi_select: Array.from(allTags).map(tag => ({ name: tag }))
    };
    Logger.log(`Adding tags to ${handle}: ${Array.from(allTags).join(', ')}`);
  }
  
  // Add Twitter logo as page icon if enabled
  if (CONFIG.ENABLE_TWITTER_ICONS) {
    try {
      const profilePicUrl = getTwitterProfilePicUrl(usernameOnly);
      createPayload.icon = {
        type: 'external',
        external: {
          url: profilePicUrl
        }
      };
      Logger.log(`Adding Twitter logo icon for ${handle}`);
    } catch (error) {
      Logger.log(`Warning: Could not add Twitter logo for ${handle}: ${error.message}`);
    }
  }
  
  const createOptions = {
    method: 'post',
    headers: {
      'Authorization': `Bearer ${CONFIG.NOTION_API_TOKEN}`,
      'Notion-Version': CONFIG.NOTION_API_VERSION,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(createPayload),
    muteHttpExceptions: true
  };
  
  const createResponse = UrlFetchApp.fetch(createUrl, createOptions);
  const createdPage = JSON.parse(createResponse.getContentText());
  
  if (createdPage.id) {
    twitterParents[handle] = createdPage.id;
    return createdPage.id;
  }
  
  throw new Error(`Failed to create Twitter parent page for ${handle}`);
}

/**
 * Update an existing Twitter parent page with tags from bookmarks
 * @param {string} pageId - ID of the parent page
 * @param {Array} userBookmarks - All bookmarks for this user to collect tags
 */
function updateTwitterParentTags(pageId, userBookmarks) {
  try {
    // Collect all unique tags from user's bookmarks
    const allTags = new Set();
    userBookmarks.forEach(bookmark => {
      if (bookmark.tags && Array.isArray(bookmark.tags)) {
        bookmark.tags.forEach(tag => allTags.add(tag));
      }
    });
    
    if (allTags.size === 0) return; // No tags to add
    
    // Update the page with tags
    const updateUrl = `${CONFIG.NOTION_API_BASE}/pages/${pageId}`;
    const updatePayload = {
      properties: {
        'Tags': {
          multi_select: Array.from(allTags).map(tag => ({ name: tag }))
        }
      }
    };
    
    const updateOptions = {
      method: 'patch',
      headers: {
        'Authorization': `Bearer ${CONFIG.NOTION_API_TOKEN}`,
        'Notion-Version': CONFIG.NOTION_API_VERSION,
        'Content-Type': 'application/json'
      },
      payload: JSON.stringify(updatePayload),
      muteHttpExceptions: true
    };
    
    const updateResponse = UrlFetchApp.fetch(updateUrl, updateOptions);
    
    if (updateResponse.getResponseCode() === 200) {
      Logger.log(`✓ Updated parent page tags: ${Array.from(allTags).join(', ')}`);
    } else {
      Logger.log(`Warning: Failed to update parent page tags: ${updateResponse.getContentText()}`);
    }
  } catch (error) {
    Logger.log(`Warning: Error updating parent page tags: ${error.message}`);
  }
}

// ============================================================================
// PROCESSING FUNCTIONS
// ============================================================================

/**
 * Check if a bookmark needs updating by comparing with Notion page
 * @param {string} pageId - Notion page ID
 * @param {Object} bookmark - Raindrop bookmark data
 * @returns {boolean} True if update is needed
 */
function bookmarkNeedsUpdate(pageId, bookmark) {
  try {
    const url = `${CONFIG.NOTION_API_BASE}/pages/${pageId}`;
    const options = {
      method: 'get',
      headers: {
        'Authorization': `Bearer ${CONFIG.NOTION_API_TOKEN}`,
        'Notion-Version': CONFIG.NOTION_API_VERSION
      },
      muteHttpExceptions: true
    };
    
    const response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() !== 200) return false;
    
    const page = JSON.parse(response.getContentText());
    const props = page.properties;
    const titleProp = getDatabaseTitlePropertyName();
    
    // Check title
    const currentTitle = props[titleProp]?.title?.[0]?.plain_text || '';
    const newTitle = bookmark.title || bookmark.link;
    if (currentTitle !== newTitle) return true;
    
    // Check type
    const currentType = props['Type']?.select?.name || '';
    const newType = bookmark.type || 'link';
    if (currentType !== newType) return true;
    
    // Check collection
    const currentCollection = props['Collection']?.select?.name || '';
    const newCollection = bookmark.collectionName || 'Unsorted';
    if (currentCollection !== newCollection) return true;
    
    // Check tags
    const currentTags = (props['Tags']?.multi_select || []).map(t => t.name).sort();
    const newTags = (bookmark.tags || []).sort();
    if (currentTags.length !== newTags.length) return true;
    for (let i = 0; i < currentTags.length; i++) {
      if (currentTags[i] !== newTags[i]) return true;
    }
    
    // Check cover image
    const currentCover = page.cover?.external?.url || '';
    const newCoverUrl = bookmark.cover ? (typeof bookmark.cover === 'string' ? bookmark.cover : bookmark.cover?.url) : '';
    if (currentCover !== newCoverUrl) return true;
    
    return false; // No changes detected
    
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
 * Update Twitter child blocks (tweets within parent pages)
 * @param {string} parentPageId - Parent page ID
 * @param {Object} bookmark - Updated bookmark data
 * @param {Array} blockIds - Block IDs to update
 * @returns {boolean} True if updated
 */
function updateTwitterChildBlocks(parentPageId, bookmark, blockIds) {
  try {
    // For now, we'll delete the old blocks and recreate them
    // This is simpler than trying to update individual blocks
    
    // Delete old blocks
    for (const blockId of blockIds) {
      try {
        deleteNotionBlock(blockId);
        Utilities.sleep(100);
      } catch (error) {
        Logger.log(`  Warning: Could not delete block ${blockId}: ${error.message}`);
      }
    }
    
    // Add updated tweet content
    const blocks = [];
    const maxChunkSize = 1900;
    
    // Add title if available
    if (bookmark.title) {
      if (bookmark.title.length <= maxChunkSize) {
        blocks.push({
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [{
              type: 'text',
              text: { content: bookmark.title }
            }]
          }
        });
      } else {
        let remainingContent = bookmark.title;
        while (remainingContent.length > 0) {
          const chunk = remainingContent.substring(0, maxChunkSize);
          remainingContent = remainingContent.substring(maxChunkSize);
          blocks.push({
            object: 'block',
            type: 'paragraph',
            paragraph: {
              rich_text: [{
                type: 'text',
                text: { content: chunk }
              }]
            }
          });
        }
      }
    }
    
    // Add excerpt if available
    if (bookmark.excerpt) {
      if (bookmark.excerpt.length <= maxChunkSize) {
        blocks.push({
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [{
              type: 'text',
              text: { content: bookmark.excerpt }
            }]
          }
        });
      } else {
        let remainingContent = bookmark.excerpt;
        while (remainingContent.length > 0) {
          const chunk = remainingContent.substring(0, maxChunkSize);
          remainingContent = remainingContent.substring(maxChunkSize);
          blocks.push({
            object: 'block',
            type: 'paragraph',
            paragraph: {
              rich_text: [{
                type: 'text',
                text: { content: chunk }
              }]
            }
          });
        }
      }
    }
    
    // Add note if available - as a quote block
    if (bookmark.note) {
      if (bookmark.note.length <= maxChunkSize) {
        blocks.push({
          object: 'block',
          type: 'quote',
          quote: {
            rich_text: [{
              type: 'text',
              text: { content: bookmark.note }
            }],
            color: 'default'
          }
        });
      } else {
        let remainingContent = bookmark.note;
        while (remainingContent.length > 0) {
          const chunk = remainingContent.substring(0, maxChunkSize);
          remainingContent = remainingContent.substring(maxChunkSize);
          blocks.push({
            object: 'block',
            type: 'quote',
            quote: {
              rich_text: [{
                type: 'text',
                text: { content: chunk }
              }],
              color: 'default'
            }
          });
        }
      }
    }
    
    // Add metadata with Raindrop ID
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{
          type: 'text',
          text: {
            content: `📅 Saved: ${formatDate(bookmark.created)} | 🆔 Raindrop ID: ${bookmark._id}`
          }
        }]
      }
    });
    
    // Add link
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{
          type: 'text',
          text: {
            content: bookmark.link,
            link: { url: bookmark.link }
          }
        }]
      }
    });
    
    // Add spacing (3 empty lines)
    for (let j = 0; j < 3; j++) {
      blocks.push({
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: [] }
      });
    }
    
    // Append new blocks
    const url = `${CONFIG.NOTION_API_BASE}/blocks/${parentPageId}/children`;
    const options = {
      method: 'patch',
      headers: {
        'Authorization': `Bearer ${CONFIG.NOTION_API_TOKEN}`,
        'Notion-Version': CONFIG.NOTION_API_VERSION,
        'Content-Type': 'application/json'
      },
      payload: JSON.stringify({ children: blocks }),
      muteHttpExceptions: true
    };
    
    const response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() === 200) {
      Logger.log(`  ✓ Updated Twitter bookmark: ${bookmark.title || bookmark.link}`);
      return true;
    }
    
    return false;
  } catch (error) {
    Logger.log(`  ❌ Error updating Twitter blocks: ${error.message}`);
    return false;
  }
}

/**
 * Process regular (non-Twitter) bookmarks in batches
 * @param {Array} bookmarks - Array of bookmark objects
 * @param {string} parentId - Optional parent page ID
 * @returns {number} Number of created pages
 */
function processBatchBookmarks(bookmarks, parentId = null, existingIdsSet = null) {
  let totalCreated = 0;
  
  // Process in batches
  for (let i = 0; i < bookmarks.length; i += CONFIG.BATCH_SIZE) {
    const batch = bookmarks.slice(i, i + CONFIG.BATCH_SIZE);
    Logger.log(`Creating batch ${Math.floor(i / CONFIG.BATCH_SIZE) + 1}: ${batch.length} pages`);
    
      const created = createNotionPagesBatch(batch, parentId, existingIdsSet);
      totalCreated += created;
      
      if (created < batch.length) {
        logError('WARNING', `Only created ${created} of ${batch.length} pages in batch`, {
          batchNumber: Math.floor(i / CONFIG.BATCH_SIZE) + 1,
          expected: batch.length,
          actual: created
        });
      }
      
      Logger.log(`✓ Created ${created} pages in this batch`);    // Delay between batches
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
      const latestBookmark = userBookmarks.sort((a, b) => new Date(b.created) - new Date(a.created))[0];
      const parentId = getOrCreateTwitterParent(username, twitterParents, latestBookmark, userBookmarks);
      
      // Add all tweets as content blocks to the parent page
      const tweetsAdded = addTweetsToParentPage(parentId, userBookmarks);
      totalCreated += tweetsAdded;
      
      // Mark all bookmarks as processed
      for (const bm of userBookmarks) {
        if (existingIdsSet) existingIdsSet.add(bm._id.toString());
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

/**
 * Add tweets as content blocks to a parent page
 * Checks for existing tweets to avoid duplicates
 * @param {string} parentId - ID of the parent page
 * @param {Array} tweets - Array of tweet bookmark objects
 * @returns {number} Number of tweets added
 */
function addTweetsToParentPage(parentId, tweets) {
  try {
    // First, get existing Raindrop IDs from this parent page
    const existingTweets = getTwitterChildrenRaindropIds(parentId);
    const existingIds = new Set(existingTweets.map(t => t.raindropId));
    
    // Filter out tweets that already exist
    const newTweets = tweets.filter(tweet => !existingIds.has(tweet._id.toString()));
    
    if (newTweets.length === 0) {
      Logger.log(`  ℹ️ All ${tweets.length} tweets already exist in parent page, skipping...`);
      return 0;
    }
    
    if (newTweets.length < tweets.length) {
      Logger.log(`  ℹ️ Skipping ${tweets.length - newTweets.length} existing tweets, adding ${newTweets.length} new tweets...`);
    }
    
    const blocks = [];
    
    for (let i = 0; i < newTweets.length; i++) {
      const tweet = newTweets[i];
      
      // Add title if available
      if (tweet.title) {
        const maxChunkSize = 1900;
        if (tweet.title.length <= maxChunkSize) {
          blocks.push({
            object: 'block',
            type: 'paragraph',
            paragraph: {
              rich_text: [
                {
                  type: 'text',
                  text: {
                    content: tweet.title
                  }
                }
              ]
            }
          });
        } else {
          // Split into multiple paragraphs if content is too long
          let remainingContent = tweet.title;
          while (remainingContent.length > 0) {
            const chunk = remainingContent.substring(0, maxChunkSize);
            remainingContent = remainingContent.substring(maxChunkSize);
            
            blocks.push({
              object: 'block',
              type: 'paragraph',
              paragraph: {
                rich_text: [
                  {
                    type: 'text',
                    text: {
                      content: chunk
                    }
                  }
                ]
              }
            });
          }
        }
      }
      
      // Add excerpt if available
      if (tweet.excerpt) {
        const maxChunkSize = 1900;
        if (tweet.excerpt.length <= maxChunkSize) {
          blocks.push({
            object: 'block',
            type: 'paragraph',
            paragraph: {
              rich_text: [
                {
                  type: 'text',
                  text: {
                    content: tweet.excerpt
                  }
                }
              ]
            }
          });
        } else {
          let remainingContent = tweet.excerpt;
          while (remainingContent.length > 0) {
            const chunk = remainingContent.substring(0, maxChunkSize);
            remainingContent = remainingContent.substring(maxChunkSize);
            
            blocks.push({
              object: 'block',
              type: 'paragraph',
              paragraph: {
                rich_text: [
                  {
                    type: 'text',
                    text: {
                      content: chunk
                    }
                  }
                ]
              }
            });
          }
        }
      }
      
      // Add note if available - as a quote block
      if (tweet.note) {
        const maxChunkSize = 1900;
        if (tweet.note.length <= maxChunkSize) {
          blocks.push({
            object: 'block',
            type: 'quote',
            quote: {
              rich_text: [
                {
                  type: 'text',
                  text: {
                    content: tweet.note
                  }
                }
              ],
              color: 'default'
            }
          });
        } else {
          let remainingContent = tweet.note;
          while (remainingContent.length > 0) {
            const chunk = remainingContent.substring(0, maxChunkSize);
            remainingContent = remainingContent.substring(maxChunkSize);
            
            blocks.push({
              object: 'block',
              type: 'quote',
              quote: {
                rich_text: [
                  {
                    type: 'text',
                    text: {
                      content: chunk
                    }
                  }
                ],
                color: 'default'
              }
            });
          }
        }
      }
      
      // Add metadata with Raindrop ID (critical for duplicate detection)
      blocks.push({
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [
            {
              type: 'text',
              text: {
                content: `📅 Saved: ${formatDate(tweet.created)} | 🆔 Raindrop ID: ${tweet._id}`
              }
            }
          ]
        }
      });
      
      // Add link on next line
      blocks.push({
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [
            {
              type: 'text',
              text: {
                content: tweet.link,
                link: { url: tweet.link }
              }
            }
          ]
        }
      });
      
      // Add 3 empty lines after each tweet for consistent spacing
      // This ensures proper separation even when tweets are added in different batches
      for (let j = 0; j < 3; j++) {
        blocks.push({
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: []
          }
        });
      }
    }
    
    // Append blocks to the parent page
    if (blocks.length > 0) {
      const url = `${CONFIG.NOTION_API_BASE}/blocks/${parentId}/children`;
      
      const options = {
        method: 'patch',
        headers: {
          'Authorization': `Bearer ${CONFIG.NOTION_API_TOKEN}`,
          'Notion-Version': CONFIG.NOTION_API_VERSION,
          'Content-Type': 'application/json'
        },
        payload: JSON.stringify({
          children: blocks
        }),
        muteHttpExceptions: true
      };
      
      const response = UrlFetchApp.fetch(url, options);
      const code = response.getResponseCode();
      
      if (code === 200) {
        Logger.log(`✓ Added ${newTweets.length} new tweets to parent page`);
        return newTweets.length;
      } else {
        Logger.log(`❌ Error adding tweets to parent page: ${code} - ${response.getContentText()}`);
        return 0;
      }
    }
    
    return 0;
    
  } catch (error) {
    Logger.log(`❌ Error in addTweetsToParentPage: ${error.message}`);
    return 0;
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
    const url = `${CONFIG.NOTION_API_BASE}/databases/${CONFIG.NOTION_DATABASE_ID}/query`;
    
    const payload = {
      page_size: 1 // Just check if any pages exist
    };
    
    const options = {
      method: 'post',
      headers: {
        'Authorization': `Bearer ${CONFIG.NOTION_API_TOKEN}`,
        'Notion-Version': CONFIG.NOTION_API_VERSION,
        'Content-Type': 'application/json'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };
    
    const response = UrlFetchApp.fetch(url, options);
    const responseCode = response.getResponseCode();
    
    if (responseCode !== 200) {
      Logger.log(`Warning: Cannot verify first run status: ${response.getContentText()}`);
      return false; // Err on side of caution
    }
    
    const data = JSON.parse(response.getContentText());
    const isEmpty = !data.results || data.results.length === 0;
    
    if (isEmpty) {
      Logger.log('✓ Database appears to be empty - confirming first run');
      return true;
    } else {
      Logger.log(`⚠️ Database contains ${data.results.length > 0 ? 'pages' : 'no pages'} but no Raindrop IDs found`);
      return false;
    }
    
  } catch (error) {
    Logger.log(`Warning: Error checking first run status: ${error.message}`);
    return false; // Err on side of caution to prevent duplicates
  }
}

/**
 * Validate that all required configuration is properly set
 * Prevents running with placeholder values that would cause immediate failures
 */
function validateConfiguration() {
  Logger.log('Validating configuration...');
  
  const requiredConfigs = {
    'RAINDROP_API_TOKEN': CONFIG.RAINDROP_API_TOKEN,
    'NOTION_API_TOKEN': CONFIG.NOTION_API_TOKEN,
    'NOTION_DATABASE_ID': CONFIG.NOTION_DATABASE_ID
  };
  
  const errors = [];
  
  for (const [key, value] of Object.entries(requiredConfigs)) {
    if (!value || value.includes('YOUR_') || value.includes('_HERE') || value.length < 10) {
      errors.push(`${key} is not configured (contains placeholder or is too short)`);
    }
  }
  
  if (errors.length > 0) {
    Logger.log('❌ CONFIGURATION ERRORS:');
  }
}

/**
 * Check if a URL is from Twitter/X
 * @param {string} url - URL to check
 * @returns {boolean} True if Twitter URL
 */
function isTwitterUrl(url) {
  if (!url) return false;
  const lowerUrl = url.toLowerCase();
  return lowerUrl.includes('twitter.com') || lowerUrl.includes('x.com');
}

/**
 * Extract Twitter handle from URL
 * @param {string} url - Twitter URL
 * @returns {string} Twitter handle without @ symbol, or null
 */
function extractTwitterHandle(url) {
  if (!url) return null;
  
  try {
    // Match patterns like twitter.com/username or x.com/username
    const match = url.match(/(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]+)/i);
    if (match && match[1]) {
      const username = match[1].toLowerCase();
      // Filter out common non-user paths
      if (['home', 'explore', 'notifications', 'messages', 'i', 'search'].includes(username)) {
        return null;
      }
      return username;
    }
  } catch (error) {
    Logger.log(`Warning: Error extracting handle from ${url}: ${error.message}`);
  }
  
  return null;
}

/**
 * Make an API request with retry logic
 * @param {Function} requestFn - Function that makes the API request
 * @returns {Object} Response from the request
 */
function makeRequestWithRetry(requestFn) {
  let lastError;
  
  for (let attempt = 0; attempt < CONFIG.MAX_RETRIES; attempt++) {
    try {
      return requestFn();
    } catch (error) {
      lastError = error;
      
      if (error.message.includes('Rate limited')) {
        // Rate limit errors should always retry
        Logger.log(`Retry attempt ${attempt + 1}/${CONFIG.MAX_RETRIES} after rate limit`);
        continue;
      }
      
      if (attempt < CONFIG.MAX_RETRIES - 1) {
        Logger.log(`Retry attempt ${attempt + 1}/${CONFIG.MAX_RETRIES}: ${error.message}`);
        Utilities.sleep(1000 * (attempt + 1)); // Exponential backoff
      }
    }
  }
  
  throw lastError;
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
 * Fetch the Notion database schema
 * @returns {Object}
 */
function fetchNotionDatabase() {
  const url = `${CONFIG.NOTION_API_BASE}/databases/${CONFIG.NOTION_DATABASE_ID}`;
  const options = {
    method: 'get',
    headers: {
      'Authorization': `Bearer ${CONFIG.NOTION_API_TOKEN}`,
      'Notion-Version': CONFIG.NOTION_API_VERSION
    },
    muteHttpExceptions: true
  };
  const resp = UrlFetchApp.fetch(url, options);
  const code = resp.getResponseCode();
  if (code !== 200) {
    throw new Error(`Failed to fetch database schema: ${code} - ${resp.getContentText()}`);
  }
  return JSON.parse(resp.getContentText());
}

/**
 * Determine the database title property name (e.g., 'Name', 'Title', etc.)
 * @returns {string}
 */
function getDatabaseTitlePropertyName() {
  if (_cachedDbTitlePropName) return _cachedDbTitlePropName;
  const db = fetchNotionDatabase();
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