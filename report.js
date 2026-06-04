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

  let active = 0, draft = 0, archived = 0, unpublished = 0, unlisted = 0;
  let createdLast7Days = 0, updatedLast7Days = 0;

  // Missing field counters (product-level)
  let missingImage = 0;
  let missingTags = 0;
  let missingCollections = 0;

  // Missing field counters (variant-level — flagged if ANY variant has issue)
  let missingSKU = 0;
  let missingBarcode = 0;
  let missingWeight = 0;
  let missingPrice = 0;
  let missingCost = 0;
  let missingSize = 0;
  let missingHSCode = 0;
  let zeroInventory = 0;

  // Duplicate tracking (across all variants)
  let skuMap = {};
  let barcodeMap = {};

  products.forEach((product) => {
    // ── Status counts ──────────────────────────────────────────
    if (product.status === "ACTIVE") active++;
    if (product.status === "DRAFT") draft++;
    if (product.status === "ARCHIVED") archived++;

    if (new Date(product.createdAt) >= sevenDaysAgo) createdLast7Days++;
    if (new Date(product.updatedAt) >= sevenDaysAgo) updatedLast7Days++;

    // ── Published / Unlisted ───────────────────────────────────
    const pubs = product.resourcePublicationsV2?.edges || [];
    if (pubs.length === 0) {
      unpublished++;
    }
    const onlineStorePub = pubs.find((e) =>
      e.node.publication?.name?.toLowerCase().includes("online store")
    );
    if (onlineStorePub && onlineStorePub.node.isPublished === false) {
      unlisted++;
    }

    // ── Product-level missing checks ───────────────────────────
    if (!product.images?.edges?.length)           missingImage++;
    if (!product.tags || product.tags.length === 0) missingTags++;
    if (!product.collections?.edges?.length)       missingCollections++;

    // ── Inventory ──────────────────────────────────────────────
    if ((product.totalInventory || 0) === 0) zeroInventory++;

    // ── Variant-level missing checks ───────────────────────────
    const variants = product.variants?.edges || [];

    let productMissingSKU      = false;
    let productMissingBarcode  = false;
    let productMissingWeight   = false;
    let productMissingPrice    = false;
    let productMissingCost     = false;
    let productMissingSize     = false;
    let productMissingHSCode   = false;

    variants.forEach(({ node: v }) => {
      if (!v.sku || v.sku.trim() === "")   productMissingSKU = true;
      if (!v.barcode || v.barcode.trim() === "") productMissingBarcode = true;
      if (!v.price || parseFloat(v.price) === 0) productMissingPrice = true;

      // Weight inside inventoryItem.measurement.weight
      const weightVal = v.inventoryItem?.measurement?.weight?.value;
      if (!weightVal || weightVal === 0)   productMissingWeight = true;

      // Cost inside inventoryItem.unitCost.amount
      const costVal = v.inventoryItem?.unitCost?.amount;
      if (!costVal || parseFloat(costVal) === 0) productMissingCost = true;

      // HS / Tariff Code
      const hsCode = v.inventoryItem?.harmonizedSystemCode;
      if (!hsCode || hsCode.trim() === "") productMissingHSCode = true;

      // Size — look for a "Size" option in selectedOptions
      const sizeOption = v.selectedOptions?.find(
        (o) => o.name.toLowerCase() === "size"
      );
      if (!sizeOption || !sizeOption.value || sizeOption.value.toLowerCase() === "default title") {
        productMissingSize = true;
      }

      // Duplicate SKU / Barcode tracking
      if (v.sku && v.sku.trim() !== "") {
        skuMap[v.sku] = (skuMap[v.sku] || 0) + 1;
      }
      if (v.barcode && v.barcode.trim() !== "") {
        barcodeMap[v.barcode] = (barcodeMap[v.barcode] || 0) + 1;
      }
    });

    if (productMissingSKU)     missingSKU++;
    if (productMissingBarcode) missingBarcode++;
    if (productMissingWeight)  missingWeight++;
    if (productMissingPrice)   missingPrice++;
    if (productMissingCost)    missingCost++;
    if (productMissingSize)    missingSize++;
    if (productMissingHSCode)  missingHSCode++;
  });

  const duplicateSKU      = Object.values(skuMap).filter((c) => c > 1).length;
  const duplicateBarcode  = Object.values(barcodeMap).filter((c) => c > 1).length;

  // ── Helper for coloured rows ───────────────────────────────
  const row = (label, value, warn = false) => `
    <tr style="background:${warn && value > 0 ? "#fff8e1" : "#fff"};">
      <td style="padding:10px; border:1px solid #ddd;">${label}</td>
      <td style="padding:10px; border:1px solid #ddd; font-weight:bold; color:${warn && value > 0 ? "#e65100" : "#111"};">${value}</td>
    </tr>`;

  const html = `
  <div style="font-family: Arial; padding:20px; background:#f6f6f6;">

    <div style="background:#111; color:#fff; padding:15px; border-radius:8px;">
      <h2 style="margin:0;">📊 Shopify Product Health Audit Report</h2>
    </div>

    <!-- PRODUCT STATUS -->
    <div style="background:#fff; padding:20px; margin-top:10px; border-radius:8px;">
      <h3 style="margin-top:0;">📦 Product Status</h3>
      <table width="100%" style="border-collapse:collapse;">
        <tr style="background:#f0f0f0;"><th style="padding:10px; border:1px solid #ddd; text-align:left;">Metric</th><th style="padding:10px; border:1px solid #ddd; text-align:left;">Count</th></tr>
        ${row("Active Products",        active)}
        ${row("Draft Products",         draft)}
        ${row("Archived Products",      archived)}
        ${row("Unpublished Products",   unpublished,  true)}
        ${row("Unlisted Products",      unlisted,     true)}
        ${row("Created Last 7 Days",    createdLast7Days)}
        ${row("Updated Last 7 Days",    updatedLast7Days)}
      </table>
    </div>

    <!-- MISSING DATA -->
    <div style="background:#fff; padding:20px; margin-top:10px; border-radius:8px;">
      <h3 style="margin-top:0;">⚠️ Missing Data (products affected)</h3>
      <table width="100%" style="border-collapse:collapse;">
        <tr style="background:#f0f0f0;"><th style="padding:10px; border:1px solid #ddd; text-align:left;">Issue</th><th style="padding:10px; border:1px solid #ddd; text-align:left;">Products</th></tr>
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
      <h3 style="margin-top:0;">🔍 Inventory & Duplicates</h3>
      <table width="100%" style="border-collapse:collapse;">
        <tr style="background:#f0f0f0;"><th style="padding:10px; border:1px solid #ddd; text-align:left;">Issue</th><th style="padding:10px; border:1px solid #ddd; text-align:left;">Count</th></tr>
        ${row("Zero Inventory",         zeroInventory,      true)}
        ${row("Duplicate SKUs",         duplicateSKU,       true)}
        ${row("Duplicate Barcodes",     duplicateBarcode,   true)}
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
    subject: "📊 Shopify Product Health Audit Report",
    html,
  });

  console.log("✅ Audit Email Sent Successfully");
}

sendReport().catch(console.error);
