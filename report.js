const axios = require("axios");
const nodemailer = require("nodemailer");

const SHOP = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_APP_PASSWORD = process.env.EMAIL_APP_PASSWORD;
const REPORT_RECIPIENT = process.env.REPORT_RECIPIENT;

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

async function sendReport() {
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

  const html = `
    <h2>Weekly Shopify Product Report</h2>

    <table border="1" cellpadding="10" cellspacing="0">
      <tr>
        <th>Metric</th>
        <th>Count</th>
      </tr>
      <tr>
        <td>Active Products</td>
        <td>${active}</td>
      </tr>
      <tr>
        <td>Draft Products</td>
        <td>${draft}</td>
      </tr>
      <tr>
        <td>Archived Products</td>
        <td>${archived}</td>
      </tr>
      <tr>
        <td>Created Last 7 Days</td>
        <td>${createdLast7Days}</td>
      </tr>
      <tr>
        <td>Updated Last 7 Days</td>
        <td>${updatedLast7Days}</td>
      </tr>
    </table>
  `;

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_APP_PASSWORD
    }
  });

  await transporter.sendMail({
    from: EMAIL_USER,
    to: REPORT_RECIPIENT,
    subject: "Weekly Shopify Product Report",
    html
  });

  console.log("Email sent successfully");
}

sendReport().catch(console.error);
