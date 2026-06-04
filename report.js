const axios = require("axios");

const SHOP = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

async function testConnection() {
  const query = `
  {
    products(first: 5) {
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
        "Content-Type": "application/json",
      },
    }
  );

  console.log(JSON.stringify(response.data, null, 2));
}

testConnection();
