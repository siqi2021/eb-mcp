import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

function generateRandom19DigitNumber() {
  let result = '';
  for (let i = 0; i < 19; i++) {
    result += Math.floor(Math.random() * 10); // Random digit (0-9)
  }
  return result;
}

function isTokenExpired(tokenExpiry: string) {
  // Extract year (20YY) and month (MM) from tokenExpiry
  const expiryYear = 2000 + parseInt(tokenExpiry.substring(0, 2), 10);
  const expiryMonth = parseInt(tokenExpiry.substring(2, 4), 10) - 1; // JS months are 0-indexed

  // Create expiry date (last day of the month)
  const expiryDate = new Date(expiryYear, expiryMonth + 1, 0); // Last day of expiry month
  const today = new Date();

  // Compare dates (ignore time)
  return today > expiryDate;
}

export const getServer = () => {
  const server = new McpServer({
    name: "eb",
    version: "1.0.0",
  });

  server.tool(
    "get_payment_token",
    "This tool generates a secure, constrained payment token for user transactions. Required inputs: 1) 'userId' (non-empty string, unique user identifier in the AI system, e.g., 'user_123456'); 2) 'amount' (number ≥0, payment value in smallest currency units like cents); 3) 'tokenExpiry' (non-empty string in YYMM format, defaults to current date +1 year, e.g., '2512' for December 2025); 4) 'availCount' (number ≥0, max token usage count, defaults to 100); 5) 'maxTransAmount' (number ≥0, per-transaction limit, defaults to 500); 6) 'totalTransAmount' (number ≥0, daily cumulative limit, defaults to 5000). The token enforces these constraints during transactions and expires at month-end of the specified YYMM period. All the information are required, for the ones you don't know, if it has default value, you could use the default value. If no default value, you can ask the user.",
    {
      userId: z.string().nonempty().describe("The unique identifier of the user in the AI agent’s system. Example: 'user_123456'"),
      amount: z.number().min(0).describe("The amount to be paid (in the smallest unit, e.g., cents)."),
      tokenExpiry: z.string().nonempty().describe("The expiry date of the token in YYMM format. Example: '2502' (February 2025). Default is 1 years from now."),
      availCount: z.number().min(0).describe("How many times the token can be used. Default is 100 times."),
      maxTransAmount: z.number().min(0).describe("The maximum allowed amount per transaction. Default is 500."),
      totalTransAmount: z.number().min(0).describe("The maximum cumulative amount allowed in one day. Default is 5000."),
    },
    async ({ userId, amount, tokenExpiry, availCount, maxTransAmount, totalTransAmount }) => {
      let responseText = generateRandom19DigitNumber();
      if (amount > maxTransAmount) {
        responseText = `The payment amount ${amount} exceeds the maximum allowed per transaction of ${maxTransAmount}.`;
      }
      if (amount > totalTransAmount) {
        responseText = `The payment amount ${amount} exceeds the daily allowed amount of ${totalTransAmount}.`;
      }
      if (isTokenExpired(tokenExpiry)) {
        responseText = `Please provide a valid token expiry date. The provided date ${tokenExpiry} is expired.`;
      }

      return {
        content: [
          {
            type: "text",
            text: responseText,
          }
        ],
      };
    }
  );

  return server;
}