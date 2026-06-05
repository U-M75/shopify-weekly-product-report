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
        pageInfo {
          hasNextPage
        }
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
              edges {
                node {
                  id
                }
              }
            }

            collections(first: 5) {
              edges {
                node {
                  id
                  title
                }
              }
            }

            variants(first: 100) {
              edges {
                node {
                  sku
                  barcode
                  price

                  selectedOptions {
                    name
                    value
                  }

                  inventoryQuantity

                  inventoryItem {
                    unitCost {
                      amount
                    }
                    measurement {
                      weight {
                        value
                        unit
                      }
                    }
                    harmonizedSystemCode
                  }
                }
              }
            }

            resourcePublicationsV2(first: 10) {
              edges {
                node {
                  isPublished
                  publication {
                    name
                  }
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

  // ── Summary counters ───────────────────────────────────────
  let active = 0, draft = 0, archived = 0, unpublished = 0, unlisted = 0;
  let createdLast7Days = 0, updatedLast7Days = 0;

  let missingImage = 0, missingTags = 0, missingCollections = 0;
  let missingSKU = 0, missingBarcode = 0, missingWeight = 0;
  let missingPrice = 0, missingCost = 0, missingSize = 0, missingHSCode = 0;
  let zeroInventory = 0;

  let skuMap = {}, barcodeMap = {};

  // ── Per-product missing info (for detail table) ────────────
  const productRows = [];

  products.forEach((product) => {
    // Status
    if (product.status === "ACTIVE")    active++;
    if (product.status === "DRAFT")     draft++;
    if (product.status === "ARCHIVED")  archived++;

    if (new Date(product.createdAt) >= sevenDaysAgo) createdLast7Days++;
    if (new Date(product.updatedAt) >= sevenDaysAgo) updatedLast7Days++;

    // Published / Unlisted
    const pubs = product.resourcePublicationsV2?.edges || [];
    if (pubs.length === 0) unpublished++;
    const onlineStorePub = pubs.find((e) =>
      e.node.publication?.name?.toLowerCase().includes("online store")
    );
    if (onlineStorePub && onlineStorePub.node.isPublished === false) unlisted++;

    // Product-level checks
    const noImage       = !product.images?.edges?.length;
    const noTags        = !product.tags || product.tags.length === 0;
    const noCollections = !product.collections?.edges?.length;
    const noInventory   = (product.totalInventory || 0) === 0;

    if (noImage)       missingImage++;
    if (noTags)        missingTags++;
    if (noCollections) missingCollections++;
    if (noInventory)   zeroInventory++;

    // Variant-level checks
    const variants = product.variants?.edges || [];

    let noSKU = false, noBarcode = false, noWeight = false;
    let noPrice = false, noCost = false, noSize = false, noHS = false;

    variants.forEach(({ node: v }) => {
      if (!v.sku     || v.sku.trim() === "")              noSKU     = true;
      if (!v.barcode || v.barcode.trim() === "")          noBarcode = true;
      if (!v.price   || parseFloat(v.price) === 0)        noPrice   = true;

      const weightVal = v.inventoryItem?.measurement?.weight?.value;
      if (!weightVal || weightVal === 0)                  noWeight  = true;

      const costVal = v.inventoryItem?.unitCost?.amount;
      if (!costVal || parseFloat(costVal) === 0)          noCost    = true;

      const hsCode = v.inventoryItem?.harmonizedSystemCode;
      if (!hsCode || hsCode.trim() === "")                noHS      = true;

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

    if (noSKU)      missingSKU++;
    if (noBarcode)  missingBarcode++;
    if (noWeight)   missingWeight++;
    if (noPrice)    missingPrice++;
    if (noCost)     missingCost++;
    if (noSize)     missingSize++;
    if (noHS)       missingHSCode++;

    // Collect missing labels for this product
    const missing = [];
    if (noBarcode)    missing.push("Barcode");
    if (noSKU)        missing.push("SKU");
    if (noWeight)     missing.push("Weight");
    if (noSize)       missing.push("Size");
    if (noImage)      missing.push("Image");
    if (noPrice)      missing.push("Price");
    if (noCost)       missing.push("Cost");
    if (noTags)       missing.push("Tags");
    if (noCollections) missing.push("Collection");
    if (noHS)         missing.push("HS Code");
    if (noInventory)  missing.push("Inventory");

    if (missing.length > 0) {
      productRows.push({ title: product.title, missing });
    }
  });

  const duplicateSKU     = Object.values(skuMap).filter((c) => c > 1).length;
  const duplicateBarcode = Object.values(barcodeMap).filter((c) => c > 1).length;

  // ── HTML helpers ───────────────────────────────────────────
  const row = (label, value, warn = false) => `
    <tr style="background:${warn && value > 0 ? "#fff8e1" : "#fff"};">
      <td style="padding:10px; border:1px solid #ddd;">${label}</td>
      <td style="padding:10px; border:1px solid #ddd; font-weight:bold; color:${warn && value > 0 ? "#e65100" : "#111"};">${value}</td>
    </tr>`;

  // Badge per missing field
  const badge = (label) =>
    `<span style="display:inline-block; margin:2px 3px; padding:3px 8px; border-radius:12px; background:#fff3e0; color:#e65100; font-size:11px; border:1px solid #ffcc80;">${label}</span>`;

  const detailRows = productRows
    .map(
      (p, i) => `
      <tr style="background:${i % 2 === 0 ? "#fff" : "#fafafa"};">
        <td style="padding:10px 12px; border:1px solid #ddd; font-weight:600; vertical-align:top; min-width:200px;">${p.title}</td>
        <td style="padding:8px 12px; border:1px solid #ddd;">${p.missing.map(badge).join("")}</td>
      </tr>`
    )
    .join("");

  const html = `
  <div style="font-family: Arial, sans-serif; padding:20px; background:#f6f6f6;">

    <!-- HEADER -->
    <div style="background:#111; color:#fff; padding:15px 20px; border-radius:8px;">
      <h2 style="margin:0;">📊 Shopify Product Health Audit Report</h2>
    </div>

    <!-- PRODUCT STATUS -->
    <div style="background:#fff; padding:20px; margin-top:10px; border-radius:8px;">
      <h3 style="margin-top:0;">📦 Product Status</h3>
      <table width="100%" style="border-collapse:collapse;">
        <tr style="background:#f0f0f0;">
          <th style="padding:10px; border:1px solid #ddd; text-align:left;">Metric</th>
          <th style="padding:10px; border:1px solid #ddd; text-align:left;">Count</th>
        </tr>
        ${row("Active Products",      active)}
        ${row("Draft Products",       draft)}
        ${row("Archived Products",    archived)}
        ${row("Unpublished Products", unpublished, true)}
        ${row("Unlisted Products",    unlisted,    true)}
        ${row("Created Last 7 Days",  createdLast7Days)}
        ${row("Updated Last 7 Days",  updatedLast7Days)}
      </table>
    </div>

    <!-- MISSING DATA SUMMARY -->
    <div style="background:#fff; padding:20px; margin-top:10px; border-radius:8px;">
      <h3 style="margin-top:0;">⚠️ Missing Data — Summary</h3>
      <table width="100%" style="border-collapse:collapse;">
        <tr style="background:#f0f0f0;">
          <th style="padding:10px; border:1px solid #ddd; text-align:left;">Issue</th>
          <th style="padding:10px; border:1px solid #ddd; text-align:left;">Products Affected</th>
        </tr>
        ${row("Missing Barcode",        missingBarcode,     true)}
        ${row("Missing SKU",            missingSKU,         true)}
        ${row("Missing Weight",         missingWeight,      true)}
        ${row("Missing Size",           missingSize,        true)}
        ${row("Missing Media / Image",  missingImage,       true)}
        ${row("Missing Price",          missingPrice,       true)}
        ${row("Missing Cost",           missingCost,        true)}
        ${row("Missing Tags",           missingTags,        true)}
        ${row("Missing Collections",    missingCollections, true)}
        ${row("Missing Tariff/HS Code", missingHSCode,      true)}
      </table>
    </div>

    <!-- INVENTORY & DUPLICATES -->
    <div style="background:#fff; padding:20px; margin-top:10px; border-radius:8px;">
      <h3 style="margin-top:0;">🔍 Inventory &amp; Duplicates</h3>
      <table width="100%" style="border-collapse:collapse;">
        <tr style="background:#f0f0f0;">
          <th style="padding:10px; border:1px solid #ddd; text-align:left;">Issue</th>
          <th style="padding:10px; border:1px solid #ddd; text-align:left;">Count</th>
        </tr>
        ${row("Zero Inventory",     zeroInventory,     true)}
        ${row("Duplicate SKUs",     duplicateSKU,      true)}
        ${row("Duplicate Barcodes", duplicateBarcode,  true)}
      </table>
    </div>

    <!-- PRODUCT DETAIL TABLE -->
    <div style="background:#fff; padding:20px; margin-top:10px; border-radius:8px;">
      <h3 style="margin-top:0;">📋 Products with Missing Information (${productRows.length} products)</h3>
      <table width="100%" style="border-collapse:collapse;">
        <tr style="background:#f0f0f0;">
          <th style="padding:10px; border:1px solid #ddd; text-align:left; width:35%;">Product Name</th>
          <th style="padding:10px; border:1px solid #ddd; text-align:left;">Missing Fields</th>
        </tr>
        ${detailRows}
      </table>
    </div>

    <p style="text-align:center; color:#888; font-size:12px; margin-top:20px;">
      Auto-generated Shopify Product Health Audit Report
    </p>

  </div>
  `;

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: EMAIL_USER, pass: EMAIL_APP_PASSWORD },
  });

  await transporter.sendMail({
    from: EMAIL_USER,
    to: REPORT_RECIPIENT,
    subject: `📊 Shopify Product Health Audit — ${productRows.length} Products Need Attention`,
    html,
  });

  console.log(`✅ Audit Email Sent — ${productRows.length} products flagged`);
}

sendReport().catch(console.error);
