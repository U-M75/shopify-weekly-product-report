const axios = require("axios");

const SHOP = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

async function getProducts() {
  const query = `
  {
    products(first: 250) {
      edges {
        node {
          id
          title
          status
          createdAt
          updatedAt
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
        "Content-Type": "application/json"
      }
    }
  );

  return response.data.data.products.edges.map(edge => edge.node);
}

async function generateReport() {
  const products = await getProducts();

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  let active = 0;
  let draft = 0;
  let archived = 0;

  let createdLast7Days = 0;
  let updatedLast7Days = 0;

  products.forEach(product => {
    if (product.status === "ACTIVE") active++;
    if (product.status === "DRAFT") draft++;
    if (product.status === "ARCHIVED") archived++;

    if (new Date(product.createdAt) >= sevenDaysAgo) {
      createdLast7Days++;
    }

    if (new Date(product.updatedAt) >= sevenDaysAgo) {
      updatedLast7Days++;
    }
  });

  console.log("===== WEEKLY PRODUCT REPORT =====");
  console.log("Active:", active);
  console.log("Draft:", draft);
  console.log("Archived:", archived);
  console.log("Created Last 7 Days:", createdLast7Days);
  console.log("Updated Last 7 Days:", updatedLast7Days);
}

generateReport();
