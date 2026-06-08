const axios = require("axios");

const SHOP = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

// ── Required checks for health score (10 total) ────────────
const REQUIRED_CHECKS = [
  "SKU", "Barcode", "Weight", "Size", "Media",
  "Price", "Cost", "Tags", "Collections", "Sales Channels",
];
const TOTAL_CHECKS = REQUIRED_CHECKS.length;

function extractId(gid) {
  return gid ? gid.split("/").pop() : null;
}

function adminLink(gid) {
  const id = extractId(gid);
  return `https://${SHOP}/admin/products/${id}`;
}

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

async function sendToSlack(payload) {
  await axios.post(SLACK_WEBHOOK_URL, payload, {
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Calculate health score for a single product.
 * Returns { passed, total, score, missing[] }
 * Required checks: SKU, Barcode, Weight, Size, Media, Price, Cost, Tags, Collections, Sales Channels
 */
function calcHealthScore(product) {
  const variants = product.variants?.edges || [];
  const pubs = product.resourcePublicationsV2?.edges || [];

  let noSKU = false, noBarcode = false, noWeight = false;
  let noPrice = false, noCost = false, noSize = false;

  variants.forEach(({ node: v }) => {
    if (!v.sku     || v.sku.trim() === "")       noSKU     = true;
    if (!v.barcode || v.barcode.trim() === "")   noBarcode = true;
    if (!v.price   || parseFloat(v.price) === 0) noPrice   = true;

    const weightVal = v.inventoryItem?.measurement?.weight?.value;
    if (!weightVal || weightVal === 0)           noWeight  = true;

    const costVal = v.inventoryItem?.unitCost?.amount;
    if (!costVal || parseFloat(costVal) === 0)   noCost    = true;

    const sizeOption = v.selectedOptions?.find(
      (o) => o.name.toLowerCase() === "size"
    );
    if (!sizeOption || !sizeOption.value ||
        sizeOption.value.toLowerCase() === "default title") noSize = true;
  });

  const noMedia       = !product.images?.edges?.length;
  const noTags        = !product.tags || product.tags.length === 0;
  const noCollections = !product.collections?.edges?.length;
  const publishedCount = pubs.filter((e) => e.node.isPublished).length;
  const noChannels    = publishedCount === 0;

  const failMap = {
    "SKU":           noSKU,
    "Barcode":       noBarcode,
    "Weight":        noWeight,
    "Size":          noSize,
    "Media":         noMedia,
    "Price":         noPrice,
    "Cost":          noCost,
    "Tags":          noTags,
    "Collections":   noCollections,
    "Sales Channels": noChannels,
  };

  const missing = REQUIRED_CHECKS.filter((k) => failMap[k]);
  const passed  = TOTAL_CHECKS - missing.length;
  const score   = Math.round((passed / TOTAL_CHECKS) * 100);

  return { passed, total: TOTAL_CHECKS, score, missing };
}

async function sendReport() {
  const products = await getProducts();

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  let active = 0, draft = 0, archived = 0, unpublished = 0, unlisted = 0;
  let createdLast7Days = 0, updatedLast7Days = 0;

  let missingImage = 0, missingTags = 0, missingCollections = 0;
  let missingSKU = 0, missingBarcode = 0, missingWeight = 0;
  let missingPrice = 0, missingCost = 0, missingSize = 0, missingHSCode = 0;
  let zeroInventory = 0;
  let skuMap = {}, barcodeMap = {};

  let missingOnlineStore = 0, missingWholesale = 0, missingPOS = 0;
  let notPublishedAnywhere = 0, channelConflict = 0;

  // For catalog health score
  let totalPassedChecks = 0;
  let totalPossibleChecks = 0;

  // For priority products (active only)
  const activeProductScores = [];

  products.forEach((product) => {
    if (product.status === "ACTIVE")   active++;
    if (product.status === "DRAFT")    draft++;
    if (product.status === "ARCHIVED") archived++;
    if (new Date(product.createdAt) >= sevenDaysAgo) createdLast7Days++;
    if (new Date(product.updatedAt) >= sevenDaysAgo) updatedLast7Days++;

    const pubs = product.resourcePublicationsV2?.edges || [];
    const getChannel = (kw) =>
      pubs.find((e) => e.node.publication?.name?.toLowerCase().includes(kw));

    const onlineStorePub = getChannel("online store");
    const wholesalePub   = getChannel("wholesale");
    const posPub         = getChannel("point of sale");

    if (pubs.length === 0) unpublished++;
    if (onlineStorePub && !onlineStorePub.node.isPublished) unlisted++;

    const isActive       = product.status === "ACTIVE";
    const noOnlineStore  = !onlineStorePub || !onlineStorePub.node.isPublished;
    const noWholesale    = !wholesalePub   || !wholesalePub.node.isPublished;
    const noPOS          = !posPub         || !posPub.node.isPublished;
    const publishedCount = pubs.filter((e) => e.node.isPublished).length;

    if (isActive && noOnlineStore)        missingOnlineStore++;
    if (isActive && noWholesale)          missingWholesale++;
    if (isActive && noPOS)                missingPOS++;
    if (isActive && publishedCount === 0) notPublishedAnywhere++;
    if (!isActive && publishedCount > 0)  channelConflict++;

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

      const sizeOption = v.selectedOptions?.find(
        (o) => o.name.toLowerCase() === "size"
      );
      if (!sizeOption || !sizeOption.value ||
          sizeOption.value.toLowerCase() === "default title") noSize = true;

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

    // ── Health Score calculation ───────────────────────────
    const health = calcHealthScore(product);

    // Catalog score: include ALL products
    totalPassedChecks   += health.passed;
    totalPossibleChecks += health.total;

    // Priority list: active products only
    if (isActive) {
      activeProductScores.push({
        title:   product.title,
        link:    adminLink(product.id),
        score:   health.score,
        missing: health.missing,
      });
    }
  });

  const duplicateSKU     = Object.values(skuMap).filter((c) => c > 1).length;
  const duplicateBarcode = Object.values(barcodeMap).filter((c) => c > 1).length;

  // ── Catalog Health Score ───────────────────────────────────
  const catalogHealthScore = totalPossibleChecks > 0
    ? Math.round((totalPassedChecks / totalPossibleChecks) * 100)
    : 0;

  // ── Priority Products: top 10 lowest-scoring active products
  const priorityProducts = activeProductScores
    .sort((a, b) => a.score - b.score)
    .slice(0, 10);

  const reportDate = new Date().toLocaleDateString("en-GB", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const stat = (emoji, label, value, warn = false) =>
    `${emoji} *${label}:* ${warn && value > 0 ? `*${value}* ⚠️` : value}`;

  function healthEmoji(score) {
    if (score >= 80) return "🟢";
    if (score >= 50) return "🟡";
    return "🔴";
  }

  // ── MESSAGE 1: Header + Summary ───────────────────────────
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
          text: `${reportDate}  •  *${active} active products*`,
        }],
      },
      { type: "divider" },

      // ── Health Scores ──────────────────────────────────────
      {
        type: "section",
        text: { type: "mrkdwn", text: "*🏥 Catalog Health Score*" },
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `${healthEmoji(catalogHealthScore)} *Overall Catalog:* ${catalogHealthScore}%`,
          },
          {
            type: "mrkdwn",
            text: `📋 *Based on:* ${TOTAL_CHECKS} required checks per product`,
          },
        ],
      },
      {
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: `Required checks: ${REQUIRED_CHECKS.join(" · ")}`,
        }],
      },
      { type: "divider" },

      // ── Product Status ─────────────────────────────────────
      { type: "section", text: { type: "mrkdwn", text: "*📦 Product Status*" } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: stat("✅", "Active",           active) },
          { type: "mrkdwn", text: stat("📝", "Draft",            draft,        true) },
          { type: "mrkdwn", text: stat("🗃️", "Archived",        archived) },
          { type: "mrkdwn", text: stat("👁️", "Unpublished",      unpublished,  true) },
          { type: "mrkdwn", text: stat("🚫", "Unlisted",         unlisted,     true) },
          { type: "mrkdwn", text: stat("🆕", "Created (7 days)", createdLast7Days) },
          { type: "mrkdwn", text: stat("🔄", "Updated (7 days)", updatedLast7Days) },
        ],
      },
      { type: "divider" },

      // ── Missing Data ───────────────────────────────────────
      { type: "section", text: { type: "mrkdwn", text: "*⚠️ Missing Data (Failed Checks)*" } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: stat("🔖", "Barcode",      missingBarcode) },
          { type: "mrkdwn", text: stat("🏷️", "SKU",          missingSKU) },
          { type: "mrkdwn", text: stat("⚖️", "Weight",       missingWeight) },
          { type: "mrkdwn", text: stat("📐", "Size",          missingSize) },
          { type: "mrkdwn", text: stat("🖼️", "Media",        missingImage) },
          { type: "mrkdwn", text: stat("💰", "Price",         missingPrice) },
          { type: "mrkdwn", text: stat("🧾", "Cost",          missingCost) },
          { type: "mrkdwn", text: stat("🏷️", "Tags",         missingTags) },
          { type: "mrkdwn", text: stat("📁", "Collections",   missingCollections) },
          { type: "mrkdwn", text: stat("🌐", "HS Code",       missingHSCode) },
        ],
      },
      { type: "divider" },

      // ── Inventory & Duplicates ─────────────────────────────
      { type: "section", text: { type: "mrkdwn", text: "*🔍 Inventory & Duplicates*" } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: stat("📦", "Zero Inventory",      zeroInventory) },
          { type: "mrkdwn", text: stat("♻️", "Duplicate SKUs",     duplicateSKU) },
          { type: "mrkdwn", text: stat("♻️", "Duplicate Barcodes", duplicateBarcode) },
        ],
      },
      { type: "divider" },

      // ── Sales Channel Audit ────────────────────────────────
      { type: "section", text: { type: "mrkdwn", text: "*📡 Sales Channel Audit*" } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: stat("🛍️", "Missing Online Store",  missingOnlineStore) },
          { type: "mrkdwn", text: stat("🤝", "Missing Wholesale",      missingWholesale) },
          { type: "mrkdwn", text: stat("🏪", "Missing POS",            missingPOS) },
          { type: "mrkdwn", text: stat("🚫", "Not Published Anywhere", notPublishedAnywhere) },
          { type: "mrkdwn", text: stat("⚡", "Channel Conflicts",      channelConflict) },
        ],
      },
    ],
  });

  await new Promise((res) => setTimeout(res, 500));

  // ── MESSAGE 2: Priority Products (top 10 lowest health scores) ──
  if (priorityProducts.length > 0) {
    const lines = priorityProducts.map((p, i) => {
      const rank    = i + 1;
      const emoji   = healthEmoji(p.score);
      const missing = p.missing.length > 0 ? p.missing.join(", ") : "—";
      return `${rank}. ${emoji} <${p.link}|${p.title}>\n   Score: *${p.score}%* · Missing: \`${missing}\``;
    });

    await sendToSlack({
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*🚨 Priority Products — Lowest Health Scores (Top ${priorityProducts.length})*\n_Active products needing immediate attention_`,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: lines.join("\n\n"),
          },
        },
      ],
    });
  }

  await new Promise((res) => setTimeout(res, 500));

  // ── FINAL: Footer ──────────────────────────────────────────
  await sendToSlack({
    blocks: [
      { type: "divider" },
      {
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: `🤖 Auto-generated Shopify Audit Report  •  ${reportDate}  •  Catalog Health: ${healthEmoji(catalogHealthScore)} ${catalogHealthScore}%`,
        }],
      },
    ],
  });

  console.log(`✅ Slack report sent — Catalog health: ${catalogHealthScore}% — ${priorityProducts.length} priority products flagged`);
}

sendReport().catch(console.error);
