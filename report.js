const axios = require("axios");
const nodemailer = require("nodemailer");

const SHOP = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_APP_PASSWORD = process.env.EMAIL_APP_PASSWORD;
const REPORT_RECIPIENT = process.env.REPORT_RECIPIENT;

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
 * 📊 SEND AUDIT REPORT
 */
async function sendReport() {
  const products = await getProducts();

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  // ── Status counters ────────────────────────────────────────
  let active = 0, draft = 0, archived = 0, unpublished = 0, unlisted = 0;
  let createdLast7Days = 0, updatedLast7Days = 0;

  // ── Missing field counters ─────────────────────────────────
  let missingImage = 0, missingTags = 0, missingCollections = 0;
  let missingSKU = 0, missingBarcode = 0, missingWeight = 0;
  let missingPrice = 0, missingCost = 0, missingSize = 0, missingHSCode = 0;
  let zeroInventory = 0;
  let skuMap = {}, barcodeMap = {};

  // ── Sales channel counters ─────────────────────────────────
  let missingOnlineStore = 0;
  let missingWholesale   = 0;
  let missingPOS         = 0;
  let notPublishedAnywhere = 0;
  let channelConflict    = 0;

  // ── Per-product rows ───────────────────────────────────────
  const productMissingRows  = [];  // missing data table
  const productChannelRows  = [];  // channel audit table

  products.forEach((product) => {
    // Status
    if (product.status === "ACTIVE")   active++;
    if (product.status === "DRAFT")    draft++;
    if (product.status === "ARCHIVED") archived++;
    if (new Date(product.createdAt) >= sevenDaysAgo) createdLast7Days++;
    if (new Date(product.updatedAt) >= sevenDaysAgo) updatedLast7Days++;

    // ── Channel detection ──────────────────────────────────
    const pubs = product.resourcePublicationsV2?.edges || [];

    const getChannel = (keyword) =>
      pubs.find((e) =>
        e.node.publication?.name?.toLowerCase().includes(keyword)
      );

    const onlineStorePub = getChannel("online store");
    const wholesalePub   = getChannel("wholesale");
    const posPub         = getChannel("point of sale");

    // Unlisted = online store exists but isPublished false
    if (pubs.length === 0) unpublished++;
    if (onlineStorePub && onlineStorePub.node.isPublished === false) unlisted++;

    // Channel missing checks (only for ACTIVE products)
    const isActive = product.status === "ACTIVE";

    const noOnlineStore = !onlineStorePub || !onlineStorePub.node.isPublished;
    const noWholesale   = !wholesalePub   || !wholesalePub.node.isPublished;
    const noPOS         = !posPub         || !posPub.node.isPublished;

    if (isActive && noOnlineStore) missingOnlineStore++;
    if (isActive && noWholesale)   missingWholesale++;
    if (isActive && noPOS)         missingPOS++;

    // Not published anywhere = active but zero published channels
    const publishedCount = pubs.filter((e) => e.node.isPublished).length;
    if (isActive && publishedCount === 0) notPublishedAnywhere++;

    // Channel conflict = product is published on some channels but status is DRAFT/ARCHIVED
    const hasPublishedChannel = publishedCount > 0;
    if (!isActive && hasPublishedChannel) channelConflict++;

    // Build channel issues list for per-product table
    const channelIssues = [];
    if (isActive && noOnlineStore) channelIssues.push("No Online Store");
    if (isActive && noWholesale)   channelIssues.push("No Wholesale");
    if (isActive && noPOS)         channelIssues.push("No POS");
    if (isActive && publishedCount === 0) channelIssues.push("Not Published Anywhere");
    if (!isActive && hasPublishedChannel) channelIssues.push("Channel Conflict");

    if (channelIssues.length > 0) {
      productChannelRows.push({ title: product.title, issues: channelIssues });
    }

    // ── Product-level missing checks ───────────────────────
    const noImage       = !product.images?.edges?.length;
    const noTags        = !product.tags || product.tags.length === 0;
    const noCollections = !product.collections?.edges?.length;
    const noInventory   = (product.totalInventory || 0) === 0;

    if (noImage)       missingImage++;
    if (noTags)        missingTags++;
    if (noCollections) missingCollections++;
    if (noInventory)   zeroInventory++;

    // ── Variant-level missing checks ───────────────────────
    const variants = product.variants?.edges || [];
    let noSKU = false, noBarcode = false, noWeight = false;
    let noPrice = false, noCost = false, noSize = false, noHS = false;

    variants.forEach(({ node: v }) => {
      if (!v.sku     || v.sku.trim() === "")         noSKU     = true;
      if (!v.barcode || v.barcode.trim() === "")     noBarcode = true;
      if (!v.price   || parseFloat(v.price) === 0)   noPrice   = true;

      const weightVal = v.inventoryItem?.measurement?.weight?.value;
      if (!weightVal || weightVal === 0)             noWeight  = true;

      const costVal = v.inventoryItem?.unitCost?.amount;
      if (!costVal || parseFloat(costVal) === 0)     noCost    = true;

      const hsCode = v.inventoryItem?.harmonizedSystemCode;
      if (!hsCode || hsCode.trim() === "")           noHS      = true;

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

    // Collect for missing detail table
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

    if (missing.length > 0) {
      productMissingRows.push({ title: product.title, missing });
    }
  });

  const duplicateSKU     = Object.values(skuMap).filter((c) => c > 1).length;
  const duplicateBarcode = Object.values(barcodeMap).filter((c) => c > 1).length;
  const totalFlagged     = new Set([
    ...productMissingRows.map((p) => p.title),
    ...productChannelRows.map((p) => p.title),
  ]).size;

  // ── HTML helpers ───────────────────────────────────────────
  const badge = (label, color = "#e65100", bg = "#fff3e0", border = "#ffcc80") =>
    `<span style="display:inline-block;margin:2px 3px;padding:3px 10px;border-radius:20px;background:${bg};color:${color};font-size:11px;font-weight:600;border:1px solid ${border};">${label}</span>`;

  const channelBadge = (label) => badge(label, "#1565c0", "#e3f2fd", "#90caf9");

  const summaryRow = (icon, label, value, warn = false) => `
    <tr>
      <td style="padding:11px 14px;border-bottom:1px solid #f0f0f0;">
        <span style="margin-right:8px;">${icon}</span>${label}
      </td>
      <td style="padding:11px 14px;border-bottom:1px solid #f0f0f0;text-align:right;">
        <span style="
          display:inline-block;
          min-width:36px;
          padding:3px 10px;
          border-radius:20px;
          font-weight:700;
          font-size:13px;
          background:${warn && value > 0 ? "#fff3e0" : "#f5f5f5"};
          color:${warn && value > 0 ? "#e65100" : "#333"};
          border:1px solid ${warn && value > 0 ? "#ffcc80" : "#e0e0e0"};
        ">${value}</span>
      </td>
    </tr>`;

  const sectionHeader = (emoji, title, subtitle = "") => `
    <div style="background:#fff;border-radius:10px;margin-top:16px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.07);">
      <div style="padding:16px 20px;border-bottom:2px solid #f5f5f5;display:flex;align-items:center;gap:10px;">
        <span style="font-size:20px;">${emoji}</span>
        <div>
          <div style="font-size:15px;font-weight:700;color:#111;">${title}</div>
          ${subtitle ? `<div style="font-size:12px;color:#888;margin-top:2px;">${subtitle}</div>` : ""}
        </div>
      </div>
      <table width="100%" style="border-collapse:collapse;">`;

  const sectionFooter = `</table></div>`;

  const detailTable = (rows, badgeFn, emptyMsg) => {
    if (rows.length === 0)
      return `<p style="color:#888;font-size:13px;padding:10px 0;">${emptyMsg}</p>`;
    return `
      <div style="overflow-x:auto;">
      <table width="100%" style="border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:#f8f8f8;">
            <th style="padding:10px 14px;border:1px solid #e8e8e8;text-align:left;width:35%;color:#555;">Product Name</th>
            <th style="padding:10px 14px;border:1px solid #e8e8e8;text-align:left;color:#555;">Issues Found</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((p, i) => `
            <tr style="background:${i % 2 === 0 ? "#fff" : "#fafafa"};">
              <td style="padding:10px 14px;border:1px solid #e8e8e8;font-weight:600;vertical-align:top;color:#222;">${p.title}</td>
              <td style="padding:8px 14px;border:1px solid #e8e8e8;">${(p.missing || p.issues).map(badgeFn).join("")}</td>
            </tr>`).join("")}
        </tbody>
      </table>
      </div>`;
  };

  const reportDate = new Date().toLocaleDateString("en-GB", {
    weekday: "long", year: "numeric", month: "long", day: "numeric"
  });

  const html = `
  <!DOCTYPE html>
  <html>
  <body style="margin:0;padding:0;background:#f0f2f5;font-family:Arial,sans-serif;">
  <div style="max-width:760px;margin:0 auto;padding:24px 16px;">

    <!-- HEADER -->
    <div style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 60%,#0f3460 100%);border-radius:12px;padding:28px 28px 24px;color:#fff;margin-bottom:4px;">
      <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#90caf9;margin-bottom:6px;">Automated Audit</div>
      <h1 style="margin:0 0 6px;font-size:22px;font-weight:800;">📊 Shopify Product Health Report</h1>
      <div style="font-size:13px;color:#b0bec5;">${reportDate}</div>
      <div style="margin-top:16px;display:inline-block;background:rgba(255,255,255,0.1);border-radius:8px;padding:10px 18px;">
        <span style="font-size:24px;font-weight:800;">${totalFlagged}</span>
        <span style="font-size:13px;color:#b0bec5;margin-left:6px;">products need attention</span>
      </div>
    </div>

    <!-- PRODUCT STATUS -->
    ${sectionHeader("📦", "Product Status", "Overview of all products by status")}
      ${summaryRow("🟢", "Active Products",      active)}
      ${summaryRow("📝", "Draft Products",        draft,       true)}
      ${summaryRow("🗄️", "Archived Products",    archived)}
      ${summaryRow("🔴", "Unpublished Products",  unpublished,  true)}
      ${summaryRow("👻", "Unlisted Products",     unlisted,     true)}
      ${summaryRow("🆕", "Created Last 7 Days",   createdLast7Days)}
      ${summaryRow("✏️", "Updated Last 7 Days",  updatedLast7Days)}
    ${sectionFooter}

    <!-- MISSING DATA SUMMARY -->
    ${sectionHeader("⚠️", "Missing Data", "Products with incomplete information")}
      ${summaryRow("🔖", "Missing Barcode",        missingBarcode,     true)}
      ${summaryRow("🏷️", "Missing SKU",           missingSKU,         true)}
      ${summaryRow("⚖️", "Missing Weight",         missingWeight,      true)}
      ${summaryRow("📐", "Missing Size",            missingSize,        true)}
      ${summaryRow("🖼️", "Missing Media / Image", missingImage,       true)}
      ${summaryRow("💰", "Missing Price",           missingPrice,       true)}
      ${summaryRow("🧾", "Missing Cost",            missingCost,        true)}
      ${summaryRow("🏷️", "Missing Tags",           missingTags,        true)}
      ${summaryRow("📁", "Missing Collections",     missingCollections, true)}
      ${summaryRow("🌐", "Missing Tariff / HS Code",missingHSCode,      true)}
    ${sectionFooter}

    <!-- INVENTORY & DUPLICATES -->
    ${sectionHeader("🔍", "Inventory & Duplicates", "Stock levels and duplicate data issues")}
      ${summaryRow("📦", "Zero Inventory",     zeroInventory,     true)}
      ${summaryRow("♻️", "Duplicate SKUs",    duplicateSKU,      true)}
      ${summaryRow("♻️", "Duplicate Barcodes",duplicateBarcode,  true)}
    ${sectionFooter}

    <!-- SALES CHANNEL AUDIT -->
    ${sectionHeader("📡", "Sales Channel / Distribution Audit", "Active products missing channel assignments")}
      ${summaryRow("🛍️", "Missing Online Store Channel",   missingOnlineStore,   true)}
      ${summaryRow("🤝", "Missing Wholesale Channel",       missingWholesale,     true)}
      ${summaryRow("🏪", "Missing POS Channel",             missingPOS,           true)}
      ${summaryRow("🚫", "Active but Not Published Anywhere", notPublishedAnywhere, true)}
      ${summaryRow("⚡", "Channel Conflict (Draft/Archived but still published)", channelConflict, true)}
    ${sectionFooter}

    <!-- PRODUCT DETAIL — MISSING DATA -->
    <div style="background:#fff;border-radius:10px;margin-top:16px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.07);">
      <div style="padding:16px 20px;border-bottom:2px solid #f5f5f5;">
        <div style="font-size:15px;font-weight:700;color:#111;">📋 Product Detail — Missing Information</div>
        <div style="font-size:12px;color:#888;margin-top:2px;">${productMissingRows.length} products with incomplete data</div>
      </div>
      <div style="padding:16px 20px;">
        ${detailTable(productMissingRows, (l) => badge(l), "✅ No missing data found!")}
      </div>
    </div>

    <!-- PRODUCT DETAIL — CHANNEL ISSUES -->
    <div style="background:#fff;border-radius:10px;margin-top:16px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.07);">
      <div style="padding:16px 20px;border-bottom:2px solid #f5f5f5;">
        <div style="font-size:15px;font-weight:700;color:#111;">📡 Product Detail — Sales Channel Issues</div>
        <div style="font-size:12px;color:#888;margin-top:2px;">${productChannelRows.length} products with channel issues</div>
      </div>
      <div style="padding:16px 20px;">
        ${detailTable(productChannelRows, channelBadge, "✅ All channels look good!")}
      </div>
    </div>

    <!-- FOOTER -->
    <div style="text-align:center;color:#aaa;font-size:11px;margin-top:24px;padding-bottom:16px;">
      Auto-generated • Shopify Product Health Audit • ${reportDate}
    </div>

  </div>
  </body>
  </html>
  `;

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: EMAIL_USER, pass: EMAIL_APP_PASSWORD },
  });

  await transporter.sendMail({
    from: EMAIL_USER,
    to: REPORT_RECIPIENT,
    subject: `📊 Shopify Audit — ${totalFlagged} Products Need Attention`,
    html,
  });

  console.log(`✅ Audit Email Sent — ${totalFlagged} products flagged`);
}

sendReport().catch(console.error);
