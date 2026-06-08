const axios = require("axios");

const SHOP              = process.env.SHOPIFY_STORE;
const TOKEN             = process.env.SHOPIFY_ACCESS_TOKEN;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

// ──────────────────────────────────────────────────────────────────────────────
//  CONFIGURATION
// ──────────────────────────────────────────────────────────────────────────────
const REQUIRED_CHECKS = [
  "SKU", "Barcode", "Weight", "Size", "Media",
  "Price", "Cost", "Tags", "Collections", "Sales Channels",
];
const TOTAL_CHECKS = REQUIRED_CHECKS.length;

// ──────────────────────────────────────────────────────────────────────────────
//  UTILITY FUNCTIONS
// ──────────────────────────────────────────────────────────────────────────────
function extractId(gid) {
  return gid ? gid.split("/").pop() : null;
}

function adminLink(gid) {
  const id = extractId(gid);
  return `https://${SHOP}/admin/products/${id}`;
}

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
  });
}

function healthLabel(score) {
  if (score >= 80) return "✅ GOOD";
  if (score >= 50) return "⚠️ FAIR";
  return "❌ POOR";
}

function progressBar(score, width = 10) {
  const filled = Math.round((score / 100) * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// ──────────────────────────────────────────────────────────────────────────────
//  SHOPIFY API - FETCH ALL PRODUCTS
// ──────────────────────────────────────────────────────────────────────────────
async function getProducts() {
  let products    = [];
  let hasNextPage = true;
  let cursor      = null;

  while (hasNextPage) {
    const query = `{
      products(first: 250 ${cursor ? `, after: "${cursor}"` : ""}) {
        pageInfo { hasNextPage }
        edges {
          cursor
          node {
            id title status createdAt updatedAt publishedAt tags totalInventory
            images(first: 1)       { edges { node { id } } }
            collections(first: 5)  { edges { node { id title } } }
            variants(first: 100) {
              edges {
                node {
                  sku barcode price
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
              edges { node { isPublished publication { name } } }
            }
          }
        }
      }
    }`;

    const response = await axios.post(
      `https://${SHOP}/admin/api/2025-10/graphql.json`,
      { query },
      { headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" } }
    );

    const responseData = response.data;

    if (responseData.errors) {
      console.error("Shopify GraphQL Errors:", JSON.stringify(responseData.errors, null, 2));
      throw new Error("GraphQL query failed");
    }
    if (!responseData.data?.products) {
      console.error("Invalid API Response:", JSON.stringify(responseData, null, 2));
      throw new Error("Products data not found");
    }

    const result = responseData.data.products;
    products.push(...result.edges.map((e) => e.node));
    hasNextPage = result.pageInfo.hasNextPage;
    if (hasNextPage && result.edges.length > 0)
      cursor = result.edges[result.edges.length - 1].cursor;
  }

  return products;
}

// ──────────────────────────────────────────────────────────────────────────────
//  SLACK SENDER
// ──────────────────────────────────────────────────────────────────────────────
async function sendToSlack(payload) {
  await axios.post(SLACK_WEBHOOK_URL, payload, {
    headers: { "Content-Type": "application/json" },
  });
}

// ──────────────────────────────────────────────────────────────────────────────
//  HEALTH SCORE CALCULATION
// ──────────────────────────────────────────────────────────────────────────────
function calcHealthScore(product) {
  const variants = product.variants?.edges || [];
  const pubs     = product.resourcePublicationsV2?.edges || [];

  let noSKU = false, noBarcode = false, noWeight = false;
  let noPrice = false, noCost = false, noSize = false;

  variants.forEach(({ node: v }) => {
    if (!v.sku     || v.sku.trim() === "")       noSKU     = true;
    if (!v.barcode || v.barcode.trim() === "")   noBarcode = true;
    if (!v.price   || parseFloat(v.price) === 0) noPrice   = true;

    const wt = v.inventoryItem?.measurement?.weight?.value;
    if (!wt || wt === 0)                         noWeight  = true;

    const ct = v.inventoryItem?.unitCost?.amount;
    if (!ct || parseFloat(ct) === 0)             noCost    = true;

    const sz = v.selectedOptions?.find((o) => o.name.toLowerCase() === "size");
    if (!sz || !sz.value || sz.value.toLowerCase() === "default title") noSize = true;
  });

  const noMedia       = !product.images?.edges?.length;
  const noTags        = !product.tags || product.tags.length === 0;
  const noCollections = !product.collections?.edges?.length;
  const noChannels    = pubs.filter((e) => e.node.isPublished).length === 0;

  const failMap = {
    "SKU": noSKU, "Barcode": noBarcode, "Weight": noWeight, "Size": noSize,
    "Media": noMedia, "Price": noPrice, "Cost": noCost, "Tags": noTags,
    "Collections": noCollections, "Sales Channels": noChannels,
  };

  const missing = REQUIRED_CHECKS.filter((k) => failMap[k]);
  const passed  = TOTAL_CHECKS - missing.length;
  const score   = Math.round((passed / TOTAL_CHECKS) * 100);

  return { passed, total: TOTAL_CHECKS, score, missing };
}

// ──────────────────────────────────────────────────────────────────────────────
//  BUILD AUDIT ROW
// ──────────────────────────────────────────────────────────────────────────────
function buildAuditRow(product) {
  const variants  = product.variants?.edges || [];
  const pubs      = product.resourcePublicationsV2?.edges || [];
  const health    = calcHealthScore(product);

  let sku = "—", barcode = "—", price = "—", cost = "—", weight = "—", size = "—";

  variants.forEach(({ node: v }) => {
    if (sku     === "—" && v.sku?.trim())                           sku     = v.sku.trim();
    if (barcode === "—" && v.barcode?.trim())                       barcode = v.barcode.trim();
    if (price   === "—" && v.price && parseFloat(v.price) > 0)     price   = `$${parseFloat(v.price).toFixed(2)}`;
    if (cost    === "—" && v.inventoryItem?.unitCost?.amount)       cost    = `$${parseFloat(v.inventoryItem.unitCost.amount).toFixed(2)}`;
    const wt = v.inventoryItem?.measurement?.weight;
    if (weight  === "—" && wt?.value && wt.value > 0)              weight  = `${wt.value} ${wt.unit}`;
    const sz = v.selectedOptions?.find((o) => o.name.toLowerCase() === "size");
    if (size    === "—" && sz?.value && sz.value.toLowerCase() !== "default title") size = sz.value;
  });

  const channels     = pubs.filter((e) => e.node.isPublished).map((e) => e.node.publication.name);
  const collections  = product.collections?.edges?.map((e) => e.node.title) || [];
  const hasMedia     = !!(product.images?.edges?.length);
  const hasTags      = !!(product.tags?.length);

  return {
    id:           extractId(product.id),
    title:        product.title,
    url:          adminLink(product.id),
    status:       product.status === "ACTIVE" ? "🟢 Active" : product.status === "DRAFT" ? "📝 Draft" : "📦 Archived",
    sku,
    barcode,
    price,
    cost,
    weight,
    size,
    media:        hasMedia ? "✅ Yes" : "❌ No",
    tags:         hasTags  ? product.tags.slice(0, 3).join(", ") + (product.tags.length > 3 ? "…" : "") : "—",
    collections:  collections.length ? collections.join(", ") : "—",
    channels:     channels.length    ? channels.join(", ")    : "—",
    missing:      health.missing.length ? health.missing.join(", ") : "✅ None",
    inventory:    product.totalInventory ?? 0,
    healthScore:  health.score,
    healthLabel:  healthLabel(health.score),
    progressBar:  progressBar(health.score),
    createdAt:    fmtDate(product.createdAt),
    updatedAt:    fmtDate(product.updatedAt),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
//  SEND AUDIT TABLE (CHUNKED)
// ──────────────────────────────────────────────────────────────────────────────
async function sendAuditTable(rows) {
  if (rows.length === 0) return;

  const CHUNK = 5;
  const total = rows.length;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk     = rows.slice(i, i + CHUNK);
    const partNum   = Math.floor(i / CHUNK) + 1;
    const partTotal = Math.ceil(total / CHUNK);
    const isFirst   = i === 0;

    const lines = chunk.map((r, idx) => {
      return [
        `*${idx + 1 + i}. <${r.url}|${r.title}>*`,
        `┌─────────────────────────────────────────────────────────────`,
        `│ ${r.progressBar} \`${r.healthScore}%\` ${r.healthLabel}  ·  Inventory: \`${r.inventory}\`  ·  Status: ${r.status}`,
        `├─────────────────────────────────────────────────────────────`,
        `│ 📦 SKU: \`${r.sku}\`  │  🏷️ Barcode: \`${r.barcode}\``,
        `│ 💰 Price: \`${r.price}\`  │  💵 Cost: \`${r.cost}\``,
        `│ ⚖️ Weight: \`${r.weight}\`  │  📐 Size: \`${r.size}\``,
        `│ 🖼️ Media: ${r.media}  │  🏷️ Tags: \`${r.tags}\``,
        `├─────────────────────────────────────────────────────────────`,
        `│ 📚 Collections: \`${r.collections}\``,
        `│ 📢 Channels: \`${r.channels}\``,
        `│ ⚠️ Missing: \`${r.missing}\``,
        `├─────────────────────────────────────────────────────────────`,
        `│ 📅 Created: ${r.createdAt}  ·  Updated: ${r.updatedAt}`,
        `│ 🆔 ID: \`${r.id}\``,
        `└─────────────────────────────────────────────────────────────`,
      ].join("\n");
    });

    const header = isFirst
      ? `📊 *FULL AUDIT TABLE* · ${total} products · (${partNum}/${partTotal})`
      : `📊 *Full Audit Table* · (${partNum}/${partTotal})`;

    await sendToSlack({
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: header },
        },
        { type: "divider" },
        ...chunk.map((_, idx) => ({
          type: "section",
          text: { type: "mrkdwn", text: lines[idx] },
        })),
      ],
    });

    if (i + CHUNK < rows.length) await delay(600);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
//  MAIN REPORT GENERATION
// ──────────────────────────────────────────────────────────────────────────────
async function sendReport() {
  const products     = await getProducts();
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  // Initialize counters
  let active = 0, draft = 0, archived = 0, unpublished = 0, unlisted = 0;
  let createdLast7Days = 0, updatedLast7Days = 0;
  let missingSKU = 0, missingBarcode = 0, missingWeight = 0, missingSize = 0;
  let missingImage = 0, missingPrice = 0, missingCost = 0;
  let missingTags = 0, missingCollections = 0, missingHSCode = 0;
  let zeroInventory = 0;
  let skuMap = {}, barcodeMap = {};
  let missingOnlineStore = 0, missingWholesale = 0, missingPOS = 0;
  let notPublishedAnywhere = 0, channelConflict = 0;
  let totalPassedChecks = 0, totalPossibleChecks = 0;

  const auditRows          = [];
  const activeProductScores = [];

  // Process each product
  products.forEach((product) => {
    if (product.status === "ACTIVE")   active++;
    if (product.status === "DRAFT")    draft++;
    if (product.status === "ARCHIVED") archived++;
    if (new Date(product.createdAt) >= sevenDaysAgo) createdLast7Days++;
    if (new Date(product.updatedAt) >= sevenDaysAgo) updatedLast7Days++;

    const pubs      = product.resourcePublicationsV2?.edges || [];
    const getChannel = (kw) =>
      pubs.find((e) => e.node.publication?.name?.toLowerCase().includes(kw));

    const onlineStorePub  = getChannel("online store");
    const wholesalePub    = getChannel("wholesale");
    const posPub          = getChannel("point of sale");
    const publishedCount  = pubs.filter((e) => e.node.isPublished).length;
    const isActive        = product.status === "ACTIVE";

    if (pubs.length === 0)                           unpublished++;
    if (onlineStorePub && !onlineStorePub.node.isPublished) unlisted++;
    if (isActive && (!onlineStorePub || !onlineStorePub.node.isPublished)) missingOnlineStore++;
    if (isActive && (!wholesalePub   || !wholesalePub.node.isPublished))   missingWholesale++;
    if (isActive && (!posPub         || !posPub.node.isPublished))         missingPOS++;
    if (isActive && publishedCount === 0) notPublishedAnywhere++;
    if (!isActive && publishedCount > 0)  channelConflict++;

    const noImage       = !product.images?.edges?.length;
    const noTags        = !product.tags?.length;
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

      const wt = v.inventoryItem?.measurement?.weight?.value;
      if (!wt || wt === 0)                         noWeight  = true;

      const ct = v.inventoryItem?.unitCost?.amount;
      if (!ct || parseFloat(ct) === 0)             noCost    = true;

      const hs = v.inventoryItem?.harmonizedSystemCode;
      if (!hs || hs.trim() === "")                 noHS      = true;

      const sz = v.selectedOptions?.find((o) => o.name.toLowerCase() === "size");
      if (!sz || !sz.value || sz.value.toLowerCase() === "default title") noSize = true;

      if (v.sku?.trim())     skuMap[v.sku]         = (skuMap[v.sku]         || 0) + 1;
      if (v.barcode?.trim()) barcodeMap[v.barcode] = (barcodeMap[v.barcode] || 0) + 1;
    });

    if (noSKU)     missingSKU++;
    if (noBarcode) missingBarcode++;
    if (noWeight)  missingWeight++;
    if (noPrice)   missingPrice++;
    if (noCost)    missingCost++;
    if (noSize)    missingSize++;
    if (noHS)      missingHSCode++;

    const health = calcHealthScore(product);
    totalPassedChecks   += health.passed;
    totalPossibleChecks += health.total;

    if (isActive) {
      activeProductScores.push({
        title:   product.title,
        link:    adminLink(product.id),
        score:   health.score,
        missing: health.missing,
      });
    }

    auditRows.push(buildAuditRow(product));
  });

  const duplicateSKU        = Object.values(skuMap).filter((c) => c > 1).length;
  const duplicateBarcode    = Object.values(barcodeMap).filter((c) => c > 1).length;
  const catalogHealthScore  = totalPossibleChecks > 0
    ? Math.round((totalPassedChecks / totalPossibleChecks) * 100)
    : 0;

  const priorityProducts = activeProductScores
    .sort((a, b) => a.score - b.score)
    .slice(0, 10);

  const reportDate = new Date().toLocaleDateString("en-GB", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const stat = (label, value, warn = false) =>
    `• *${label}:* ${warn && value > 0 ? `*${value}* ⚠️` : value}`;

  // ──────────────────────────────────────────────────────────────────────────
  //  MESSAGE 1: HEADER + CATALOG SUMMARY
  // ──────────────────────────────────────────────────────────────────────────
  await sendToSlack({
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "📊 Shopify Product Health Audit", emoji: true },
      },
      {
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: `📅 ${reportDate}  ·  📦 ${products.length} total products  ·  🟢 ${active} active`,
        }],
      },
      { type: "divider" },

      // Catalog Health Score
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🎯 *CATALOG HEALTH SCORE*\n\`${progressBar(catalogHealthScore)} ${catalogHealthScore}% ${healthLabel(catalogHealthScore)}\`\n_Based on ${TOTAL_CHECKS} required checks per product_`,
        },
      },
      { type: "divider" },

      // Product Status
      {
        type: "section",
        text: { type: "mrkdwn", text: "📋 *PRODUCT STATUS*" },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: stat("🟢 Active",           active) },
          { type: "mrkdwn", text: stat("📝 Draft",            draft,           true) },
          { type: "mrkdwn", text: stat("📦 Archived",         archived) },
          { type: "mrkdwn", text: stat("🚫 Unpublished",      unpublished,     true) },
          { type: "mrkdwn", text: stat("👻 Unlisted",         unlisted,        true) },
          { type: "mrkdwn", text: stat("🆕 Created (7 days)", createdLast7Days) },
          { type: "mrkdwn", text: stat("🔄 Updated (7 days)", updatedLast7Days) },
        ],
      },
      { type: "divider" },

      // Missing Data
      {
        type: "section",
        text: { type: "mrkdwn", text: "⚠️ *MISSING DATA — FAILED CHECKS*" },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: stat("🏷️ Barcode",     missingBarcode) },
          { type: "mrkdwn", text: stat("🔖 SKU",         missingSKU) },
          { type: "mrkdwn", text: stat("⚖️ Weight",      missingWeight) },
          { type: "mrkdwn", text: stat("📐 Size",        missingSize) },
          { type: "mrkdwn", text: stat("🖼️ Media",       missingImage) },
          { type: "mrkdwn", text: stat("💰 Price",       missingPrice) },
          { type: "mrkdwn", text: stat("💵 Cost",        missingCost) },
          { type: "mrkdwn", text: stat("🏷️ Tags",        missingTags) },
          { type: "mrkdwn", text: stat("📚 Collections", missingCollections) },
          { type: "mrkdwn", text: stat("🔢 HS Code",     missingHSCode) },
        ],
      },
      { type: "divider" },

      // Inventory & Duplicates
      {
        type: "section",
        text: { type: "mrkdwn", text: "📊 *INVENTORY & DUPLICATES*" },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: stat("📦 Zero Inventory",    zeroInventory) },
          { type: "mrkdwn", text: stat("🔄 Duplicate SKUs",    duplicateSKU) },
          { type: "mrkdwn", text: stat("🔄 Duplicate Barcodes",duplicateBarcode) },
        ],
      },
      { type: "divider" },

      // Sales Channel Audit
      {
        type: "section",
        text: { type: "mrkdwn", text: "📢 *SALES CHANNEL AUDIT*" },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: stat("🛒 Missing Online Store",   missingOnlineStore) },
          { type: "mrkdwn", text: stat("� wholesale Missing Wholesale",      missingWholesale) },
          { type: "mrkdwn", text: stat("📱 Missing POS",            missingPOS) },
          { type: "mrkdwn", text: stat("🌍 Not Published Anywhere", notPublishedAnywhere) },
          { type: "mrkdwn", text: stat("⚠️ Channel Conflicts",      channelConflict) },
        ],
      },
    ],
  });

  await delay(500);

  // ──────────────────────────────────────────────────────────────────────────
  //  MESSAGE 2: PRIORITY PRODUCTS
  // ──────────────────────────────────────────────────────────────────────────
  if (priorityProducts.length > 0) {
    const lines = priorityProducts.map((p, i) => {
      const missing = p.missing.length > 0 ? p.missing.join(", ") : "None";
      const bar = progressBar(p.score);
      return `${i + 1}. *<${p.link}|${p.title}>*\n   \`${bar} ${p.score}% ${healthLabel(p.score)}\`  ·  Missing: \`${missing}\``;
    });

    await sendToSlack({
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `🚨 *PRIORITY PRODUCTS — LOWEST HEALTH SCORES* (Top ${priorityProducts.length})\n_Active products needing immediate attention_`,
          },
        },
        { type: "divider" },
        {
          type: "section",
          text: { type: "mrkdwn", text: lines.join("\n\n") },
        },
      ],
    });
  }

  await delay(500);

  // ──────────────────────────────────────────────────────────────────────────
  //  MESSAGES 3+: FULL AUDIT TABLE
  // ──────────────────────────────────────────────────────────────────────────
  await sendAuditTable(auditRows);

  await delay(500);

  // ──────────────────────────────────────────────────────────────────────────
  //  FOOTER
  // ──────────────────────────────────────────────────────────────────────────
  await sendToSlack({
    blocks: [
      { type: "divider" },
      {
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: `🤖 Auto-generated Shopify Audit  ·  📅 ${reportDate}  ·  🎯 Catalog Health: ${catalogHealthScore}% ${healthLabel(catalogHealthScore)}`,
        }],
      },
    ],
  });

  console.log(`✅ Report sent — ${products.length} products — Catalog health: ${catalogHealthScore}%`);
}

// ──────────────────────────────────────────────────────────────────────────────
//  RUN
// ──────────────────────────────────────────────────────────────────────────────
sendReport().catch(console.error);
