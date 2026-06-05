const axios = require("axios");

const SHOP = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

/**
 * ✅ GET ALL PRODUCTS (FULL DATA FOR AUDIT)
 */
async function getProducts() {
  let products = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const query = `
    {
      products(first: 250 ${cursor ? `, after: "${cursor}"` : ""}) {
        pageInfo { hasNextPage }
        edges {
          cursor
          node {
            id
            title
            status
            createdAt
            updatedAt
            publishedAt
            tags
            totalInventory

            images(first: 1) {
              edges { node { id } }
            }

            collections(first: 5) {
              edges { node { id title } }
            }

            variants(first: 100) {
              edges {
                node {
                  sku
                  barcode
                  price
                  selectedOptions { name value }
                  inventoryQuantity
                  inventoryItem {
                    unitCost { amount }
                    measurement { weight { value unit } }
                    harmonizedSystemCode
                  }
                }
              }
            }

            resourcePublicationsV2(first: 10) {
              edges {
                node {
                  isPublished
                  publication { name }
                }
              }
            }
          }
        }
      }
    }`;

    const response = await axios.post(
      `https://${SHOP}/admin/api/2025-10/graphql.json`,
      { query },
      {
        headers: {
          "X-Shopify-Access-Token": TOKEN,
          "Content-Type": "application/json",
        },
      }
    );

    const responseData = response.data;

    if (responseData.errors) {
      console.log("❌ Shopify GraphQL Errors:");
      console.log(JSON.stringify(responseData.errors, null, 2));
      throw new Error("GraphQL query failed");
    }

    if (!responseData.data || !responseData.data.products) {
      console.log("❌ Invalid API Response:");
      console.log(JSON.stringify(responseData, null, 2));
      throw new Error("Products data not found");
    }

    const result = responseData.data.products;
    products.push(...result.edges.map((edge) => edge.node));

    hasNextPage = result.pageInfo.hasNextPage;
    if (hasNextPage && result.edges.length > 0) {
      cursor = result.edges[result.edges.length - 1].cursor;
    }
  }

  return products;
}

/**
 * 📤 SEND TO SLACK
 */
async function sendToSlack(payload) {
  await axios.post(SLACK_WEBHOOK_URL, payload, {
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * 📊 BUILD & SEND AUDIT REPORT
 */
async function sendReport() {
  const products = await getProducts();

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  // ── Counters ───────────────────────────────────────────────
  let active = 0, draft = 0, archived = 0, unpublished = 0, unlisted = 0;
  let createdLast7Days = 0, updatedLast7Days = 0;

  let missingImage = 0, missingTags = 0, missingCollections = 0;
  let missingSKU = 0, missingBarcode = 0, missingWeight = 0;
  let missingPrice = 0, missingCost = 0, missingSize = 0, missingHSCode = 0;
  let zeroInventory = 0;
  let skuMap = {}, barcodeMap = {};

  let missingOnlineStore = 0, missingWholesale = 0, missingPOS = 0;
  let notPublishedAnywhere = 0, channelConflict = 0;

  const productMissingRows = [];
  const productChannelRows = [];

  products.forEach((product) => {
    if (product.status === "ACTIVE")   active++;
    if (product.status === "DRAFT")    draft++;
    if (product.status === "ARCHIVED") archived++;
    if (new Date(product.createdAt) >= sevenDaysAgo) createdLast7Days++;
    if (new Date(product.updatedAt) >= sevenDaysAgo) updatedLast7Days++;

    // Channel checks
    const pubs = product.resourcePublicationsV2?.edges || [];
    const getChannel = (kw) => pubs.find((e) => e.node.publication?.name?.toLowerCase().includes(kw));

    const onlineStorePub = getChannel("online store");
    const wholesalePub   = getChannel("wholesale");
    const posPub         = getChannel("point of sale");

    if (pubs.length === 0) unpublished++;
    if (onlineStorePub && !onlineStorePub.node.isPublished) unlisted++;

    const isActive = product.status === "ACTIVE";
    const noOnlineStore = !onlineStorePub || !onlineStorePub.node.isPublished;
    const noWholesale   = !wholesalePub   || !wholesalePub.node.isPublished;
    const noPOS         = !posPub         || !posPub.node.isPublished;
    const publishedCount = pubs.filter((e) => e.node.isPublished).length;

    if (isActive && noOnlineStore)      missingOnlineStore++;
    if (isActive && noWholesale)        missingWholesale++;
    if (isActive && noPOS)              missingPOS++;
    if (isActive && publishedCount === 0) notPublishedAnywhere++;
    if (!isActive && publishedCount > 0)  channelConflict++;

    const channelIssues = [];
    if (isActive && noOnlineStore)       channelIssues.push("No Online Store");
    if (isActive && noWholesale)         channelIssues.push("No Wholesale");
    if (isActive && noPOS)               channelIssues.push("No POS");
    if (isActive && publishedCount === 0) channelIssues.push("Not Published Anywhere");
    if (!isActive && publishedCount > 0)  channelIssues.push("Channel Conflict");
    if (channelIssues.length > 0) productChannelRows.push({ title: product.title, issues: channelIssues });

    // Missing checks
    const noImage       = !product.images?.edges?.length;
    const noTags        = !product.tags || product.tags.length === 0;
    const noCollections = !product.collections?.edges?.length;
    const noInventory   = (product.totalInventory || 0) === 0;

    if (noImage)       missingImage++;
    if (noTags)        missingTags++;
    if (noCollections) missingCollections++;
    if (noInventory)   zeroInventory++;

    const variants = product.variants?.edges || [];
    let noSKU = false, noBarcode = false, noWeight = false;
    let noPrice = false, noCost = false, noSize = false, noHS = false;

    variants.forEach(({ node: v }) => {
      if (!v.sku     || v.sku.trim() === "")       noSKU     = true;
      if (!v.barcode || v.barcode.trim() === "")   noBarcode = true;
      if (!v.price   || parseFloat(v.price) === 0) noPrice   = true;

      const weightVal = v.inventoryItem?.measurement?.weight?.value;
      if (!weightVal || weightVal === 0)           noWeight  = true;

      const costVal = v.inventoryItem?.unitCost?.amount;
      if (!costVal || parseFloat(costVal) === 0)   noCost    = true;

      const hsCode = v.inventoryItem?.harmonizedSystemCode;
      if (!hsCode || hsCode.trim() === "")         noHS      = true;

      const sizeOption = v.selectedOptions?.find((o) => o.name.toLowerCase() === "size");
      if (!sizeOption || !sizeOption.value || sizeOption.value.toLowerCase() === "default title") noSize = true;

      if (v.sku && v.sku.trim() !== "")
        skuMap[v.sku] = (skuMap[v.sku] || 0) + 1;
      if (v.barcode && v.barcode.trim() !== "")
        barcodeMap[v.barcode] = (barcodeMap[v.barcode] || 0) + 1;
    });

    if (noSKU)     missingSKU++;
    if (noBarcode) missingBarcode++;
    if (noWeight)  missingWeight++;
    if (noPrice)   missingPrice++;
    if (noCost)    missingCost++;
    if (noSize)    missingSize++;
    if (noHS)      missingHSCode++;

    const missing = [];
    if (noBarcode)     missing.push("Barcode");
    if (noSKU)         missing.push("SKU");
    if (noWeight)      missing.push("Weight");
    if (noSize)        missing.push("Size");
    if (noImage)       missing.push("Image");
    if (noPrice)       missing.push("Price");
    if (noCost)        missing.push("Cost");
    if (noTags)        missing.push("Tags");
    if (noCollections) missing.push("Collection");
    if (noHS)          missing.push("HS Code");
    if (noInventory)   missing.push("Inventory");
    if (missing.length > 0) productMissingRows.push({ title: product.title, missing });
  });

  const duplicateSKU     = Object.values(skuMap).filter((c) => c > 1).length;
  const duplicateBarcode = Object.values(barcodeMap).filter((c) => c > 1).length;
  const totalFlagged     = new Set([
    ...productMissingRows.map((p) => p.title),
    ...productChannelRows.map((p) => p.title),
  ]).size;

  const reportDate = new Date().toLocaleDateString("en-GB", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  // ── Slack helper: stat line ────────────────────────────────
  const stat = (emoji, label, value, warn = false) =>
    `${emoji} *${label}:* ${warn && value > 0 ? `*${value}* ⚠️` : value}`;

  // ── Slack helper: product list (max 20 to avoid message limits) ──
  const productList = (rows, fieldKey) => {
    if (rows.length === 0) return "_✅ None_";
    const lines = rows.slice(0, 20).map(
      (p) => `• *${p.title}* — ${(p[fieldKey] || []).join(", ")}`
    );
    if (rows.length > 20) lines.push(`_...and ${rows.length - 20} more_`);
    return lines.join("\n");
  };

  // ── Build Slack Block Kit payload ─────────────────────────
  const payload = {
    blocks: [

      // ── HEADER ──────────────────────────────────────────
      {
        type: "header",
        text: { type: "plain_text", text: "📊 Shopify Product Health Audit", emoji: true },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `${reportDate}  •  *${totalFlagged} products need attention*` }],
      },
      { type: "divider" },

      // ── PRODUCT STATUS ───────────────────────────────────
      {
        type: "section",
        text: { type: "mrkdwn", text: "*📦 Product Status*" },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: stat("🟢", "Active",           active) },
          { type: "mrkdwn", text: stat("📝", "Draft",            draft,        true) },
          { type: "mrkdwn", text: stat("🗄️", "Archived",        archived) },
          { type: "mrkdwn", text: stat("🔴", "Unpublished",      unpublished,  true) },
          { type: "mrkdwn", text: stat("👻", "Unlisted",         unlisted,     true) },
          { type: "mrkdwn", text: stat("🆕", "Created (7 days)", createdLast7Days) },
          { type: "mrkdwn", text: stat("✏️", "Updated (7 days)", updatedLast7Days) },
        ],
      },
      { type: "divider" },

      // ── MISSING DATA ─────────────────────────────────────
      {
        type: "section",
        text: { type: "mrkdwn", text: "*⚠️ Missing Data*" },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: stat("🔖", "Barcode",      missingBarcode,     true) },
          { type: "mrkdwn", text: stat("🏷️", "SKU",         missingSKU,         true) },
          { type: "mrkdwn", text: stat("⚖️", "Weight",       missingWeight,      true) },
          { type: "mrkdwn", text: stat("📐", "Size",          missingSize,        true) },
          { type: "mrkdwn", text: stat("🖼️", "Image",        missingImage,       true) },
          { type: "mrkdwn", text: stat("💰", "Price",         missingPrice,       true) },
          { type: "mrkdwn", text: stat("🧾", "Cost",          missingCost,        true) },
          { type: "mrkdwn", text: stat("🏷️", "Tags",         missingTags,        true) },
          { type: "mrkdwn", text: stat("📁", "Collections",   missingCollections, true) },
          { type: "mrkdwn", text: stat("🌐", "HS Code",       missingHSCode,      true) },
        ],
      },
      { type: "divider" },

      // ── INVENTORY & DUPLICATES ───────────────────────────
      {
        type: "section",
        text: { type: "mrkdwn", text: "*🔍 Inventory & Duplicates*" },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: stat("📦", "Zero Inventory",     zeroInventory,     true) },
          { type: "mrkdwn", text: stat("♻️", "Duplicate SKUs",    duplicateSKU,      true) },
          { type: "mrkdwn", text: stat("♻️", "Duplicate Barcodes",duplicateBarcode,  true) },
        ],
      },
      { type: "divider" },

      // ── SALES CHANNEL AUDIT ──────────────────────────────
      {
        type: "section",
        text: { type: "mrkdwn", text: "*📡 Sales Channel / Distribution Audit*" },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: stat("🛍️", "Missing Online Store", missingOnlineStore,   true) },
          { type: "mrkdwn", text: stat("🤝", "Missing Wholesale",     missingWholesale,     true) },
          { type: "mrkdwn", text: stat("🏪", "Missing POS",           missingPOS,           true) },
          { type: "mrkdwn", text: stat("🚫", "Not Published Anywhere",notPublishedAnywhere, true) },
          { type: "mrkdwn", text: stat("⚡", "Channel Conflicts",     channelConflict,      true) },
        ],
      },
      { type: "divider" },

      // ── PRODUCT DETAIL — MISSING DATA ────────────────────
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*📋 Products with Missing Data* (${productMissingRows.length} products)\n${productList(productMissingRows, "missing")}`,
        },
      },
      { type: "divider" },

      // ── PRODUCT DETAIL — CHANNEL ISSUES ─────────────────
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*📡 Products with Channel Issues* (${productChannelRows.length} products)\n${productList(productChannelRows, "issues")}`,
        },
      },
      { type: "divider" },

      // ── FOOTER ──────────────────────────────────────────
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: `🤖 Auto-generated Shopify Audit Report  •  ${reportDate}` },
        ],
      },
    ],
  };

  await sendToSlack(payload);
  console.log(`✅ Slack report sent — ${totalFlagged} products flagged`);
}

sendReport().catch(console.error);
