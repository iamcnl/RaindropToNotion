# Raindrop.io to Notion Sync

This Google Apps Script provides a one-way synchronization from your Raindrop.io bookmarks to a Notion database. It's designed to be set up once and run automatically, keeping your Notion workspace updated with your latest saved links, articles, tweets, and more.

## Key Features
*   **Automatic Sync:** Set up a daily trigger to automatically import new bookmarks.
*   **Comprehensive Metadata:** Syncs title, URL, tags, collection, creation date, cover images, and icons.
*   **Smart Twitter Organization:** Groups tweets by user into dedicated parent pages in Notion, keeping your database clean.
*   **Update & Delete:** Checks for changes in existing bookmarks and automatically removes Notion pages for bookmarks deleted from Raindrop.
*   **Duplicate Detection:** Avoids creating duplicate entries for bookmarks that have already been synced.
*   **Resilient:** Handles API rate limits and script execution time limits gracefully, resuming on the next run.
*   **Highly Configurable:** Use simple toggles in the script to enable/disable features like cover images, Twitter organization, and auto-deletion.
*   **Easy Setup:** Includes a helper function to automatically configure your Notion database with the required properties.

## Example Database
You can view a [example of the Notion database](https://www.notion.so/RaindropToNotion-Example-2c563589cb9580f88809cbbbb700ac2b) to see how your synced bookmarks will look.

## Setup and Usage
Follow these steps to get the sync running.

### Step 1: Prerequisites
1.  **Raindrop.io Account:** You'll need your [Raindrop.io API token](https://app.raindrop.io/settings/integrations).
2.  **Notion Account:**
    *   Create a new [Notion integration](https://www.notion.so/my-integrations) to get your **Notion API Token**.
    *   Create a new, empty database in Notion.
    *   Share the database with your integration (click the `•••` menu in top right, `Connections`, and select your integration).
    *   Get your **Notion Database ID**. This is the 32-character alphanumeric string in your database URL. For example, in the URL `https://www.notion.so/2c163589cb9580be9730edc9b65bc88d?v=2c163589cb9580fd84f0000c47817bde`, the database ID would be `2c163589cb9580be9730edc9b65bc88d`.

### Step 2: Google Apps Script Setup
1.  Go to [script.google.com](https://script.google.com).
2.  Click **New project**.
3.  Delete the default `Code.gs` content and paste the entire content of the `RaindropToNotion.gs` file.
4.  Save the project and give it a name (e.g., "RaindropToNotion").

### Step 3: Configure the Script
1.  In the script editor, locate the `CONFIG` section at the top.
2.  Fill in the required values:
    *   `RAINDROP_API_TOKEN`: Your API token from Raindrop.io.
    *   `NOTION_API_TOKEN`: Your internal integration token from Notion.
    *   `NOTION_DATABASE_ID`: The ID of the Notion database you created.
3.  Review the "Feature toggles" and adjust them to your preference. The defaults are recommended for the first run.

### Step 4: Prepare Your Notion Database
The script needs specific properties in your Notion database to store the bookmark data. A helper function automates this.
1.  In the Apps Script editor, select the function `setupDatabaseProperties` from the dropdown menu at the top.
2.  Click **Run**.
3.  You will be prompted to grant permissions for the script to access external services. Authorize these permissions.
4.  The script will now add the following properties to your Notion database: `Raindrop ID`, `URL`, `Type`, `Collection`, `Tags`, and `Date Saved`.

### Step 5: Run the First Sync
1.  Select the function `syncRaindropToNotion` from the function dropdown.
2.  Click **Run**.
3.  The script will start fetching your Raindrop.io bookmarks and creating pages in Notion. You can monitor the progress in the **Execution Log** at the bottom of the editor. This may take several minutes depending on the number of bookmarks you have. The script is designed to run for a maximum of 5.5 minutes and will gracefully stop, resuming where it left off on the next run.

### Step 6: Automate the Sync
Once you've confirmed the initial sync works, you can set it to run automatically every day.
1.  Select the function `createDailyTrigger` from the function dropdown.
2.  Click **Run**.
3.  This will schedule `syncRaindropToNotion` to run automatically every day at the hour specified in `TRIGGER_HOUR` (default is 8 PM / 20:00).

That's it! Your sync is now fully automated.

## How Twitter Organization Works
When `ENABLE_TWITTER_ORGANIZATION` is set to `true`, the script handles bookmarks from Twitter/X differently to avoid cluttering your database.

*   **Parent Pages:** For each Twitter user (e.g., `@username`), a single parent page is created in your Notion database (e.g., "@username on Twitter"). This page has a `Type` of `tweets`.
*   **Content Blocks:** Individual tweets from that user are not created as new database pages. Instead, their content is added as blocks inside the user's parent page.
*   **Clean Database:** This keeps your main database view clean, containing only one entry per Twitter user you've saved bookmarks from, rather than one entry per tweet.
*   **Disabling:** If you set `ENABLE_TWITTER_ORGANIZATION` to `false`, tweets will be saved as regular bookmarks, each getting its own page in the database.

## Advanced Configuration
The `CONFIG` section at the top of the script provides several options for fine-tuning its behavior:

| Constant | Description |
| --- | --- |
| `ENABLE_COVERS` | Set to `false` to prevent the script from adding cover images to Notion pages. |
| `ENABLE_ICONS` | Set to `false` to disable adding page icons (which typically use the cover image URL). |
| `ENABLE_PAGE_CONTENT`| Set to `false` to disable adding the bookmark's excerpt or note as content within the Notion page. |
| `ENABLE_AUTO_DELETE` | Set to `false` to stop the script from deleting Notion pages when the corresponding bookmark is deleted in Raindrop. |
| `ENABLE_UPDATE_CHECK`| Set to `false` to skip checking for updates on existing bookmarks. This speeds up the sync but won't reflect changes made in Raindrop after the initial import. |
| `MAX_EXECUTION_TIME` | The script will stop gracefully before hitting the Google Apps Script 6-minute execution limit. You can lower this if needed. |
| `TRIGGER_HOUR` | The hour (0-23) when the daily sync should run. |
| `MAX_DELETIONS_PER_RUN` | Safety limit. A run that would archive more Notion pages than this aborts the delete step instead. |
| `ALLOW_MASS_DELETION` | Set to `true` to override `MAX_DELETIONS_PER_RUN` when you really did remove that many bookmarks. |

## Management Functions
The script includes a couple of helper functions for managing triggers, which you can run from the script editor:

*   `listTriggers()`: Logs all active triggers for this script.
*   `deleteAllTriggers()`: Removes all triggers associated with the sync function. Useful if you want to stop the automatic sync or reconfigure it.