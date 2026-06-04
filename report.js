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

            variants(first: 100) {
              edges {
                node {
                  sku
                  barcode
                  price
                  weight
                  inventoryQuantity
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

  let active = 0;
  let draft = 0;
  let archived = 0;

  let missingSKU = 0;
  let missingBarcode = 0;
  let missingWeight = 0;
  let missingImage = 0;
  let missingPrice = 0;
  let missingTags = 0;
  let zeroInventory = 0;

  let skuMap = {};
  let barcodeMap = {};

  let createdLast7Days = 0;
  let updatedLast7Days = 0;

  products.forEach((product) => {
    if (product.status === "ACTIVE") active++;
    if (product.status === "DRAFT") draft++;
    if (product.status === "ARCHIVED") archived++;

    if (new Date(product.createdAt) >= sevenDaysAgo) {
      createdLast7Days++;
    }

    if (new Date(product.updatedAt) >= sevenDaysAgo) {
      updatedLast7Days++;
    }

    const variants = product.variants?.edges || [];
    const firstVariant = variants[0]?.node || {};

    // -------------------
    // Missing checks
    // -------------------
    if (!firstVariant.sku) missingSKU++;
    if (!firstVariant.barcode) missingBarcode++;
    if (!firstVariant.weight) missingWeight++;
    if (!firstVariant.price) missingPrice++;
    if (!product.images?.edges?.length) missingImage++;
    if (!product.tags || product.tags.length === 0) missingTags++;

    const totalInventory = product.totalInventory || 0;
    if (totalInventory === 0) zeroInventory++;

    // -------------------
    // Duplicate tracking
    // -------------------
    if (firstVariant.sku) {
      skuMap[firstVariant.sku] = (skuMap[firstVariant.sku] || 0) + 1;
    }

    if (firstVariant.barcode) {
      barcodeMap[firstVariant.barcode] =
        (barcodeMap[firstVariant.barcode] || 0) + 1;
    }
  });

  const duplicateSKU = Object.values(skuMap).filter((c) => c > 1).length;
  const duplicateBarcode = Object.values(barcodeMap).filter((c) => c > 1).length;

  const html = `
  <div style="font-family: Arial; padding:20px; background:#f6f6f6;">
    
    <div style="background:#111; color:#fff; padding:15px; border-radius:8px;">
      <h2 style="margin:0;">📊 Shopify Product Health Audit Report</h2>
    </div>

    <div style="background:#fff; padding:20px; margin-top:10px; border-radius:8px;">

      <h3>📦 Product Summary</h3>

      <table border="1" cellpadding="10" cellspacing="0" width="100%" style="border-collapse:collapse;">
        <tr><th>Metric</th><th>Count</th></tr>

        <tr><td>Active Products</td><td>${active}</td></tr>
        <tr><td>Draft Products</td><td>${draft}</td></tr>
        <tr><td>Archived Products</td><td>${archived}</td></tr>

        <tr><td>Missing SKU</td><td>${missingSKU}</td></tr>
        <tr><td>Missing Barcode</td><td>${missingBarcode}</td></tr>
        <tr><td>Missing Weight</td><td>${missingWeight}</td></tr>
        <tr><td>Missing Image</td><td>${missingImage}</td></tr>
        <tr><td>Missing Price</td><td>${missingPrice}</td></tr>
        <tr><td>Missing Tags</td><td>${missingTags}</td></tr>

        <tr><td>Zero Inventory</td><td>${zeroInventory}</td></tr>

        <tr><td>Duplicate SKU</td><td>${duplicateSKU}</td></tr>
        <tr><td>Duplicate Barcode</td><td>${duplicateBarcode}</td></tr>

        <tr><td>Created Last 7 Days</td><td>${createdLast7Days}</td></tr>
        <tr><td>Updated Last 7 Days</td><td>${updatedLast7Days}</td></tr>
      </table>

    </div>

    <p style="text-align:center; color:#888; font-size:12px; margin-top:20px;">
      Auto-generated Shopify Monday Audit Report
    </p>

  </div>
  `;

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_APP_PASSWORD,
    },
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
