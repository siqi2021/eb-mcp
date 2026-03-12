import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import path from "node:path";
import { Agent, type Dispatcher } from "undici";

const DEFAULT_BILLING_API_BASE_URL = "https://test.api.easybilling.cloud/billing";
const BILLING_CA_CERT_PATH = process.env.EB_BILLING_CA_CERT_PATH;
const BILLING_TLS_INSECURE = process.env.EB_BILLING_TLS_INSECURE === "true";

let billingDispatcher: Agent | null | undefined;

dns.setDefaultResultOrder("ipv4first");

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

function resolveBillingApiBaseUrl(apiBaseUrl?: string) {
  return apiBaseUrl || process.env.EB_BILLING_API_BASE_URL || DEFAULT_BILLING_API_BASE_URL;
}

function getBillingDispatcher(): Dispatcher | undefined {
  if (billingDispatcher !== undefined) {
    return billingDispatcher ?? undefined;
  }

  const connectOptions: { ca?: string; rejectUnauthorized?: boolean } = {};

  if (BILLING_CA_CERT_PATH) {
    const certPath = path.resolve(BILLING_CA_CERT_PATH);
    connectOptions.ca = fs.readFileSync(certPath, "utf8");
  }

  if (BILLING_TLS_INSECURE) {
    connectOptions.rejectUnauthorized = false;
  }

  if (!connectOptions.ca && connectOptions.rejectUnauthorized === undefined) {
    billingDispatcher = null;
    return undefined;
  }

  billingDispatcher = new Agent({
    connect: connectOptions,
  });

  return billingDispatcher;
}

async function secureFetch(input: string, init: RequestInit) {
  const dispatcher = input.startsWith("https://") ? getBillingDispatcher() : undefined;

  if (!dispatcher) {
    return fetch(input, init);
  }

  return fetch(input, {
    ...init,
    dispatcher,
  } as RequestInit & { dispatcher: Dispatcher });
}

function formatRequestError(error: unknown) {
  if (!(error instanceof Error)) {
    return "Unknown error";
  }

  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const causeWithFields = cause as { code?: unknown; message?: unknown };
    const causeCode = typeof causeWithFields.code === "string" ? causeWithFields.code : undefined;
    const causeMessage = typeof causeWithFields.message === "string" ? causeWithFields.message : undefined;
    const details = [causeCode, causeMessage].filter(Boolean).join(" - ");

    if (details) {
      return `${error.message} (${details})`;
    }
  }

  return error.message;
}

export const getServer = () => {
  const server = new McpServer({
    name: "eb",
    version: "1.0.0",
  });
  let cachedBillingToken: string | undefined;

  server.tool(
    "eb_billing_login",
    "Use this tool to authenticate a user against EasyBilling via POST /api/authenticate/login. Collect 'username' and 'password' from the user through conversation before calling. Optionally provide 'apiBaseUrl' if different from environment config. The tool sends trace-id automatically and returns login result including token when successful.",
    {
      username: z.string().nonempty().describe("The EasyBilling username, usually an email. Example: user@easybilling.cloud"),
      password: z.string().nonempty().describe("The EasyBilling password."),
      apiBaseUrl: z.string().url().optional().describe("Optional EasyBilling API base URL, for example: https://billing.example.com"),
    },
    async ({ username, password, apiBaseUrl }) => {
      const resolvedBaseUrl = resolveBillingApiBaseUrl(apiBaseUrl);

      if (!resolvedBaseUrl) {
        return {
          content: [
            {
              type: "text",
              text: "Missing API base URL. Provide 'apiBaseUrl' in this tool call or set environment variable 'EB_BILLING_API_BASE_URL'.",
            },
          ],
        };
      }

      const endpoint = `${resolvedBaseUrl.replace(/\/$/, "")}/api/authenticate/login`;

      try {
        const response = await secureFetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "trace-id": randomUUID(),
          },
          body: JSON.stringify({ username, password }),
        });

        const contentType = response.headers.get("content-type") ?? "";
        const responseBody = contentType.includes("application/json")
          ? await response.json()
          : await response.text();

        if (!response.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Login failed (${response.status}). Response: ${typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody)}`,
              },
            ],
          };
        }

        if (responseBody && typeof responseBody === "object" && "token" in responseBody) {
          const tokenValue = (responseBody as { token?: unknown }).token;
          if (typeof tokenValue === "string" && tokenValue.length > 0) {
            cachedBillingToken = tokenValue;
          }
        }

        return {
          content: [
            {
              type: "text",
              text: typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody),
            },
          ],
        };
      } catch (error) {
        const errorMessage = formatRequestError(error);
        return {
          content: [
            {
              type: "text",
              text: `Login request error: ${errorMessage}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "eb_billing_logout",
    "Use this tool to log out from EasyBilling via POST /api/authenticate/logout. Provide 'token' if available; if omitted, this tool will try to use the token cached from eb_billing_login in the same MCP session. Optionally provide 'apiBaseUrl' if different from environment config. The tool sends Authorization bearer token and trace-id automatically.",
    {
      token: z.string().optional().describe("Optional bearer token returned by eb_billing_login. If omitted, cached session token will be used."),
      apiBaseUrl: z.string().url().optional().describe("Optional EasyBilling API base URL, for example: https://billing.example.com"),
    },
    async ({ token, apiBaseUrl }) => {
      const resolvedBaseUrl = resolveBillingApiBaseUrl(apiBaseUrl);
      const tokenToUse = token ?? cachedBillingToken;

      if (!resolvedBaseUrl) {
        return {
          content: [
            {
              type: "text",
              text: "Missing API base URL. Provide 'apiBaseUrl' in this tool call or set environment variable 'EB_BILLING_API_BASE_URL'.",
            },
          ],
        };
      }

      if (!tokenToUse) {
        return {
          content: [
            {
              type: "text",
              text: "Missing token. Provide 'token' or call eb_billing_login first in the same MCP session to cache it.",
            },
          ],
        };
      }

      const endpoint = `${resolvedBaseUrl.replace(/\/$/, "")}/api/authenticate/logout`;

      try {
        const response = await secureFetch(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${tokenToUse}`,
            "trace-id": randomUUID(),
          },
        });

        const contentType = response.headers.get("content-type") ?? "";
        const responseBody = contentType.includes("application/json")
          ? await response.json()
          : await response.text();

        if (!response.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Logout failed (${response.status}). Response: ${typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody)}`,
              },
            ],
          };
        }

        cachedBillingToken = undefined;

        return {
          content: [
            {
              type: "text",
              text: typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody),
            },
          ],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [
            {
              type: "text",
              text: `Logout request error: ${errorMessage}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "eb_billing_create_account",
    "Create an account via POST /api/accounts. Required input: 'name'. Optional inputs: 'number', 'addressLine1', 'addressLine2', 'country', 'state', 'city', 'postalCode', 'email', 'source', 'taxExempt', 'apiBaseUrl', 'token'. If 'token' is omitted, the tool will use token cached from eb_billing_login in the same MCP session.",
    {
      name: z.string().min(1).max(128).describe("Required. Customer account name."),
      number: z.string().min(1).max(128).optional().describe("Optional. Your own account number/identifier."),
      addressLine1: z.string().min(6).max(256).optional().describe("Optional. Primary address line."),
      addressLine2: z.string().optional().describe("Optional. Secondary address line."),
      country: z.string().optional().describe("Optional. Country code, for example: US."),
      state: z.string().optional().describe("Optional. State or province."),
      city: z.string().optional().describe("Optional. City."),
      postalCode: z.string().optional().describe("Optional. Postal code."),
      email: z.string().email().optional().describe("Optional. Email address."),
      source: z.string().optional().describe("Optional. Account source label."),
      taxExempt: z.boolean().optional().describe("Optional. Tax exemption flag."),
      token: z.string().optional().describe("Optional bearer token. If omitted, cached token from login will be used."),
      apiBaseUrl: z.string().url().optional().describe("Optional EasyBilling API base URL, for example: https://billing.example.com"),
    },
    async (input) => {
      const {
        name,
        number,
        addressLine1,
        addressLine2,
        country,
        state,
        city,
        postalCode,
        email,
        source,
        taxExempt,
        token,
        apiBaseUrl,
      } = input;

      const resolvedBaseUrl = resolveBillingApiBaseUrl(apiBaseUrl);
      const tokenToUse = token ?? cachedBillingToken;

      if (!resolvedBaseUrl) {
        return {
          content: [{ type: "text", text: "Missing API base URL. Provide 'apiBaseUrl' or set 'EB_BILLING_API_BASE_URL'." }],
        };
      }

      if (!tokenToUse) {
        return {
          content: [{ type: "text", text: "Missing token. Provide 'token' or call eb_billing_login first in the same MCP session." }],
        };
      }

      const endpoint = `${resolvedBaseUrl.replace(/\/$/, "")}/api/accounts`;

      try {
        const response = await secureFetch(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${tokenToUse}`,
            "content-type": "application/json",
            "trace-id": randomUUID(),
          },
          body: JSON.stringify({
            name,
            number,
            addressLine1,
            addressLine2,
            country,
            state,
            city,
            postalCode,
            email,
            source,
            taxExempt,
          }),
        });

        const contentType = response.headers.get("content-type") ?? "";
        const responseBody = contentType.includes("application/json") ? await response.json() : await response.text();

        if (!response.ok) {
          return {
            content: [{ type: "text", text: `Create account failed (${response.status}). Response: ${typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody)}` }],
          };
        }

        return {
          content: [{ type: "text", text: typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody) }],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Create account request error: ${errorMessage}` }],
        };
      }
    }
  );

  server.tool(
    "eb_billing_list_accounts",
    "List all accounts via GET /api/accounts. Required input: none. Optional inputs: 'token', 'apiBaseUrl'. If 'token' is omitted, the tool will use token cached from eb_billing_login in the same MCP session.",
    {
      token: z.string().optional().describe("Optional bearer token. If omitted, cached token from login will be used."),
      apiBaseUrl: z.string().url().optional().describe("Optional EasyBilling API base URL, for example: https://billing.example.com"),
    },
    async ({ token, apiBaseUrl }) => {
      const resolvedBaseUrl = resolveBillingApiBaseUrl(apiBaseUrl);
      const tokenToUse = token ?? cachedBillingToken;

      if (!resolvedBaseUrl) {
        return {
          content: [{ type: "text", text: "Missing API base URL. Provide 'apiBaseUrl' or set 'EB_BILLING_API_BASE_URL'." }],
        };
      }

      if (!tokenToUse) {
        return {
          content: [{ type: "text", text: "Missing token. Provide 'token' or call eb_billing_login first in the same MCP session." }],
        };
      }

      const endpoint = `${resolvedBaseUrl.replace(/\/$/, "")}/api/accounts`;

      try {
        const response = await secureFetch(endpoint, {
          method: "GET",
          headers: {
            authorization: `Bearer ${tokenToUse}`,
            "trace-id": randomUUID(),
          },
        });

        const contentType = response.headers.get("content-type") ?? "";
        const responseBody = contentType.includes("application/json") ? await response.json() : await response.text();

        if (!response.ok) {
          return {
            content: [{ type: "text", text: `List accounts failed (${response.status}). Response: ${typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody)}` }],
          };
        }

        return {
          content: [{ type: "text", text: typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody) }],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `List accounts request error: ${errorMessage}` }],
        };
      }
    }
  );

  server.tool(
    "eb_billing_get_account_by_id",
    "Get an account by id via GET /api/accounts/{id}. Required input: 'id'. Optional inputs: 'token', 'apiBaseUrl'. If 'token' is omitted, the tool will use token cached from eb_billing_login in the same MCP session.",
    {
      id: z.string().nonempty().describe("Required. Account id."),
      token: z.string().optional().describe("Optional bearer token. If omitted, cached token from login will be used."),
      apiBaseUrl: z.string().url().optional().describe("Optional EasyBilling API base URL, for example: https://billing.example.com"),
    },
    async ({ id, token, apiBaseUrl }) => {
      const resolvedBaseUrl = resolveBillingApiBaseUrl(apiBaseUrl);
      const tokenToUse = token ?? cachedBillingToken;

      if (!resolvedBaseUrl) {
        return {
          content: [{ type: "text", text: "Missing API base URL. Provide 'apiBaseUrl' or set 'EB_BILLING_API_BASE_URL'." }],
        };
      }

      if (!tokenToUse) {
        return {
          content: [{ type: "text", text: "Missing token. Provide 'token' or call eb_billing_login first in the same MCP session." }],
        };
      }

      const endpoint = `${resolvedBaseUrl.replace(/\/$/, "")}/api/accounts/${encodeURIComponent(id)}`;

      try {
        const response = await secureFetch(endpoint, {
          method: "GET",
          headers: {
            authorization: `Bearer ${tokenToUse}`,
            "trace-id": randomUUID(),
          },
        });

        const contentType = response.headers.get("content-type") ?? "";
        const responseBody = contentType.includes("application/json") ? await response.json() : await response.text();

        if (!response.ok) {
          return {
            content: [{ type: "text", text: `Get account by id failed (${response.status}). Response: ${typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody)}` }],
          };
        }

        return {
          content: [{ type: "text", text: typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody) }],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Get account by id request error: ${errorMessage}` }],
        };
      }
    }
  );

  server.tool(
    "eb_billing_update_account_by_id",
    "Update an account via PUT /api/accounts/{id}. Required input: 'id'. Optional inputs: 'name', 'addressLine1', 'addressLine2', 'country', 'state', 'city', 'postalCode', 'email', 'status', 'source', 'taxExempt', 'token', 'apiBaseUrl'. If 'token' is omitted, the tool will use token cached from eb_billing_login in the same MCP session.",
    {
      id: z.string().nonempty().describe("Required. Account id to update."),
      name: z.string().min(1).max(128).optional().describe("Optional. Customer account name."),
      addressLine1: z.string().min(6).max(256).optional().describe("Optional. Primary address line."),
      addressLine2: z.string().optional().describe("Optional. Secondary address line."),
      country: z.string().optional().describe("Optional. Country code, for example: US."),
      state: z.string().optional().describe("Optional. State or province."),
      city: z.string().optional().describe("Optional. City."),
      postalCode: z.string().optional().describe("Optional. Postal code."),
      email: z.string().email().optional().describe("Optional. Email address."),
      status: z.enum(["active", "in-active", "draft"]).optional().describe("Optional. Account status."),
      source: z.string().optional().describe("Optional. Account source label."),
      taxExempt: z.boolean().optional().describe("Optional. Tax exemption flag."),
      token: z.string().optional().describe("Optional bearer token. If omitted, cached token from login will be used."),
      apiBaseUrl: z.string().url().optional().describe("Optional EasyBilling API base URL, for example: https://billing.example.com"),
    },
    async ({
      id,
      name,
      addressLine1,
      addressLine2,
      country,
      state,
      city,
      postalCode,
      email,
      status,
      source,
      taxExempt,
      token,
      apiBaseUrl,
    }) => {
      const resolvedBaseUrl = resolveBillingApiBaseUrl(apiBaseUrl);
      const tokenToUse = token ?? cachedBillingToken;

      if (!resolvedBaseUrl) {
        return {
          content: [{ type: "text", text: "Missing API base URL. Provide 'apiBaseUrl' or set 'EB_BILLING_API_BASE_URL'." }],
        };
      }

      if (!tokenToUse) {
        return {
          content: [{ type: "text", text: "Missing token. Provide 'token' or call eb_billing_login first in the same MCP session." }],
        };
      }

      const endpoint = `${resolvedBaseUrl.replace(/\/$/, "")}/api/accounts/${encodeURIComponent(id)}`;

      try {
        const response = await secureFetch(endpoint, {
          method: "PUT",
          headers: {
            authorization: `Bearer ${tokenToUse}`,
            "content-type": "application/json",
            "trace-id": randomUUID(),
          },
          body: JSON.stringify({
            name,
            addressLine1,
            addressLine2,
            country,
            state,
            city,
            postalCode,
            email,
            status,
            source,
            taxExempt,
          }),
        });

        const contentType = response.headers.get("content-type") ?? "";
        const responseBody = contentType.includes("application/json") ? await response.json() : await response.text();

        if (!response.ok) {
          return {
            content: [{ type: "text", text: `Update account failed (${response.status}). Response: ${typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody)}` }],
          };
        }

        return {
          content: [{ type: "text", text: typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody) }],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Update account request error: ${errorMessage}` }],
        };
      }
    }
  );

  server.tool(
    "eb_billing_get_account_by_number",
    "Get an account by account number via GET /api/accounts/number/{accountNumber}. Required input: 'accountNumber'. Optional inputs: 'token', 'apiBaseUrl'. If 'token' is omitted, the tool will use token cached from eb_billing_login in the same MCP session.",
    {
      accountNumber: z.string().nonempty().describe("Required. Account number."),
      token: z.string().optional().describe("Optional bearer token. If omitted, cached token from login will be used."),
      apiBaseUrl: z.string().url().optional().describe("Optional EasyBilling API base URL, for example: https://billing.example.com"),
    },
    async ({ accountNumber, token, apiBaseUrl }) => {
      const resolvedBaseUrl = resolveBillingApiBaseUrl(apiBaseUrl);
      const tokenToUse = token ?? cachedBillingToken;

      if (!resolvedBaseUrl) {
        return {
          content: [{ type: "text", text: "Missing API base URL. Provide 'apiBaseUrl' or set 'EB_BILLING_API_BASE_URL'." }],
        };
      }

      if (!tokenToUse) {
        return {
          content: [{ type: "text", text: "Missing token. Provide 'token' or call eb_billing_login first in the same MCP session." }],
        };
      }

      const endpoint = `${resolvedBaseUrl.replace(/\/$/, "")}/api/accounts/number/${encodeURIComponent(accountNumber)}`;

      try {
        const response = await secureFetch(endpoint, {
          method: "GET",
          headers: {
            authorization: `Bearer ${tokenToUse}`,
            "trace-id": randomUUID(),
          },
        });

        const contentType = response.headers.get("content-type") ?? "";
        const responseBody = contentType.includes("application/json") ? await response.json() : await response.text();

        if (!response.ok) {
          return {
            content: [{ type: "text", text: `Get account by number failed (${response.status}). Response: ${typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody)}` }],
          };
        }

        return {
          content: [{ type: "text", text: typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody) }],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Get account by number request error: ${errorMessage}` }],
        };
      }
    }
  );

  server.tool(
    "eb_billing_get_invoices",
    "Get invoices via GET /api/invoices. Optional inputs: 'accountNumber', 'token', 'apiBaseUrl'. If 'token' is omitted, the tool will use token cached from eb_billing_login in the same MCP session.",
    {
      accountNumber: z.string().optional().describe("Optional account number for filtering invoices."),
      token: z.string().optional().describe("Optional bearer token. If omitted, cached token from login will be used."),
      apiBaseUrl: z.string().url().optional().describe("Optional EasyBilling API base URL, for example: https://billing.example.com"),
    },
    async ({ accountNumber, token, apiBaseUrl }) => {
      const resolvedBaseUrl = resolveBillingApiBaseUrl(apiBaseUrl);
      const tokenToUse = token ?? cachedBillingToken;

      if (!resolvedBaseUrl) {
        return {
          content: [{ type: "text", text: "Missing API base URL. Provide 'apiBaseUrl' or set 'EB_BILLING_API_BASE_URL'." }],
        };
      }

      if (!tokenToUse) {
        return {
          content: [{ type: "text", text: "Missing token. Provide 'token' or call eb_billing_login first in the same MCP session." }],
        };
      }

      const baseEndpoint = `${resolvedBaseUrl.replace(/\/$/, "")}/api/invoices`;
      const endpoint = accountNumber
        ? `${baseEndpoint}?accountNumber=${encodeURIComponent(accountNumber)}`
        : baseEndpoint;

      try {
        const response = await secureFetch(endpoint, {
          method: "GET",
          headers: {
            authorization: `Bearer ${tokenToUse}`,
            "trace-id": randomUUID(),
          },
        });

        const contentType = response.headers.get("content-type") ?? "";
        const responseBody = contentType.includes("application/json") ? await response.json() : await response.text();

        if (!response.ok) {
          return {
            content: [{ type: "text", text: `Get invoices failed (${response.status}). Response: ${typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody)}` }],
          };
        }

        return {
          content: [{ type: "text", text: typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody) }],
        };
      } catch (error) {
        const errorMessage = formatRequestError(error);
        return {
          content: [{ type: "text", text: `Get invoices request error: ${errorMessage}` }],
        };
      }
    }
  );

  server.tool(
    "eb_billing_get_invoice_by_id",
    "Get invoice details via GET /api/invoices/{invoiceId}. Required input: 'invoiceId'. Optional inputs: 'token', 'apiBaseUrl'. If 'token' is omitted, the tool will use token cached from eb_billing_login in the same MCP session.",
    {
      invoiceId: z.string().nonempty().describe("Required. Invoice id."),
      token: z.string().optional().describe("Optional bearer token. If omitted, cached token from login will be used."),
      apiBaseUrl: z.string().url().optional().describe("Optional EasyBilling API base URL, for example: https://billing.example.com"),
    },
    async ({ invoiceId, token, apiBaseUrl }) => {
      const resolvedBaseUrl = resolveBillingApiBaseUrl(apiBaseUrl);
      const tokenToUse = token ?? cachedBillingToken;

      if (!resolvedBaseUrl) {
        return {
          content: [{ type: "text", text: "Missing API base URL. Provide 'apiBaseUrl' or set 'EB_BILLING_API_BASE_URL'." }],
        };
      }

      if (!tokenToUse) {
        return {
          content: [{ type: "text", text: "Missing token. Provide 'token' or call eb_billing_login first in the same MCP session." }],
        };
      }

      const endpoint = `${resolvedBaseUrl.replace(/\/$/, "")}/api/invoices/${encodeURIComponent(invoiceId)}`;

      try {
        const response = await secureFetch(endpoint, {
          method: "GET",
          headers: {
            authorization: `Bearer ${tokenToUse}`,
            "trace-id": randomUUID(),
          },
        });

        const contentType = response.headers.get("content-type") ?? "";
        const responseBody = contentType.includes("application/json") ? await response.json() : await response.text();

        if (!response.ok) {
          return {
            content: [{ type: "text", text: `Get invoice by id failed (${response.status}). Response: ${typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody)}` }],
          };
        }

        return {
          content: [{ type: "text", text: typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody) }],
        };
      } catch (error) {
        const errorMessage = formatRequestError(error);
        return {
          content: [{ type: "text", text: `Get invoice by id request error: ${errorMessage}` }],
        };
      }
    }
  );

  server.tool(
    "eb_billing_create_contract_actions",
    "Create contract actions via POST /api/contract-actions. Required inputs: 'accountNumber', 'actions'. Optional inputs: 'token', 'apiBaseUrl'. If 'token' is omitted, the tool will use token cached from eb_billing_login in the same MCP session.",
    {
      accountNumber: z.string().nonempty().describe("Required. Account number."),
      actions: z.array(z.record(z.unknown())).min(1).describe("Required. Contract actions array."),
      token: z.string().optional().describe("Optional bearer token. If omitted, cached token from login will be used."),
      apiBaseUrl: z.string().url().optional().describe("Optional EasyBilling API base URL, for example: https://billing.example.com"),
    },
    async ({ accountNumber, actions, token, apiBaseUrl }) => {
      const resolvedBaseUrl = resolveBillingApiBaseUrl(apiBaseUrl);
      const tokenToUse = token ?? cachedBillingToken;

      if (!resolvedBaseUrl) {
        return {
          content: [{ type: "text", text: "Missing API base URL. Provide 'apiBaseUrl' or set 'EB_BILLING_API_BASE_URL'." }],
        };
      }

      if (!tokenToUse) {
        return {
          content: [{ type: "text", text: "Missing token. Provide 'token' or call eb_billing_login first in the same MCP session." }],
        };
      }

      const endpoint = `${resolvedBaseUrl.replace(/\/$/, "")}/api/contract-actions`;

      try {
        const response = await secureFetch(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${tokenToUse}`,
            "content-type": "application/json",
            "trace-id": randomUUID(),
          },
          body: JSON.stringify({
            accountNumber,
            actions,
          }),
        });

        const contentType = response.headers.get("content-type") ?? "";
        const responseBody = contentType.includes("application/json") ? await response.json() : await response.text();

        if (!response.ok) {
          return {
            content: [{ type: "text", text: `Create contract actions failed (${response.status}). Response: ${typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody)}` }],
          };
        }

        return {
          content: [{ type: "text", text: typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody) }],
        };
      } catch (error) {
        const errorMessage = formatRequestError(error);
        return {
          content: [{ type: "text", text: `Create contract actions request error: ${errorMessage}` }],
        };
      }
    }
  );

  server.tool(
    "eb_billing_ingest_usage_events",
    "Ingest usage events via POST /api/usage-events. Required input: 'events' (1-100 items). Optional inputs: 'token', 'apiBaseUrl'. If 'token' is omitted, the tool will use token cached from eb_billing_login in the same MCP session.",
    {
      events: z.array(z.object({
        eventId: z.string().min(1),
        schemaName: z.string().min(1),
        eventTime: z.string().min(1),
        accountNumber: z.string().min(1),
        attributes: z.array(z.object({
          name: z.string().min(1),
          value: z.string().min(1),
        })).min(1),
      }).passthrough()).min(1).max(100).describe("Required. Usage events array."),
      token: z.string().optional().describe("Optional bearer token. If omitted, cached token from login will be used."),
      apiBaseUrl: z.string().url().optional().describe("Optional EasyBilling API base URL, for example: https://billing.example.com"),
    },
    async ({ events, token, apiBaseUrl }) => {
      const resolvedBaseUrl = resolveBillingApiBaseUrl(apiBaseUrl);
      const tokenToUse = token ?? cachedBillingToken;

      if (!resolvedBaseUrl) {
        return {
          content: [{ type: "text", text: "Missing API base URL. Provide 'apiBaseUrl' or set 'EB_BILLING_API_BASE_URL'." }],
        };
      }

      if (!tokenToUse) {
        return {
          content: [{ type: "text", text: "Missing token. Provide 'token' or call eb_billing_login first in the same MCP session." }],
        };
      }

      const endpoint = `${resolvedBaseUrl.replace(/\/$/, "")}/api/usage-events`;

      try {
        const response = await secureFetch(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${tokenToUse}`,
            "content-type": "application/json",
            "trace-id": randomUUID(),
          },
          body: JSON.stringify(events),
        });

        const contentType = response.headers.get("content-type") ?? "";
        const responseBody = contentType.includes("application/json") ? await response.json() : await response.text();

        if (!response.ok) {
          return {
            content: [{ type: "text", text: `Ingest usage events failed (${response.status}). Response: ${typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody)}` }],
          };
        }

        return {
          content: [{ type: "text", text: typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody) }],
        };
      } catch (error) {
        const errorMessage = formatRequestError(error);
        return {
          content: [{ type: "text", text: `Ingest usage events request error: ${errorMessage}` }],
        };
      }
    }
  );

  server.tool(
    "eb_billing_get_buckets_by_account_id",
    "Get buckets by account id via GET /api/buckets/{accountId}. Required input: 'accountId'. Optional inputs: 'token', 'apiBaseUrl'. If 'token' is omitted, the tool will use token cached from eb_billing_login in the same MCP session.",
    {
      accountId: z.string().nonempty().describe("Required. Account id."),
      token: z.string().optional().describe("Optional bearer token. If omitted, cached token from login will be used."),
      apiBaseUrl: z.string().url().optional().describe("Optional EasyBilling API base URL, for example: https://billing.example.com"),
    },
    async ({ accountId, token, apiBaseUrl }) => {
      const resolvedBaseUrl = resolveBillingApiBaseUrl(apiBaseUrl);
      const tokenToUse = token ?? cachedBillingToken;

      if (!resolvedBaseUrl) {
        return {
          content: [{ type: "text", text: "Missing API base URL. Provide 'apiBaseUrl' or set 'EB_BILLING_API_BASE_URL'." }],
        };
      }

      if (!tokenToUse) {
        return {
          content: [{ type: "text", text: "Missing token. Provide 'token' or call eb_billing_login first in the same MCP session." }],
        };
      }

      const endpoint = `${resolvedBaseUrl.replace(/\/$/, "")}/api/buckets/${encodeURIComponent(accountId)}`;

      try {
        const response = await secureFetch(endpoint, {
          method: "GET",
          headers: {
            authorization: `Bearer ${tokenToUse}`,
            "trace-id": randomUUID(),
          },
        });

        const contentType = response.headers.get("content-type") ?? "";
        const responseBody = contentType.includes("application/json") ? await response.json() : await response.text();

        if (!response.ok) {
          return {
            content: [{ type: "text", text: `Get buckets by account id failed (${response.status}). Response: ${typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody)}` }],
          };
        }

        return {
          content: [{ type: "text", text: typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody) }],
        };
      } catch (error) {
        const errorMessage = formatRequestError(error);
        return {
          content: [{ type: "text", text: `Get buckets by account id request error: ${errorMessage}` }],
        };
      }
    }
  );

  server.tool(
    "eb_billing_create_payment_method",
    "Set up payment method via POST /api/payment-methods. Required inputs: 'customerIdentifier', 'paymentGatewayType', 'redirectUrl', 'cancelUrl'. Optional inputs: 'token', 'apiBaseUrl'. If 'token' is omitted, the tool will use token cached from eb_billing_login in the same MCP session.",
    {
      customerIdentifier: z.string().nonempty().describe("Required. Customer identifier."),
      paymentGatewayType: z.string().nonempty().describe("Required. Payment gateway type, for example: stripe-connect."),
      redirectUrl: z.string().url().describe("Required. Redirect URL after payment setup."),
      cancelUrl: z.string().url().describe("Required. Cancel URL when setup is canceled."),
      token: z.string().optional().describe("Optional bearer token. If omitted, cached token from login will be used."),
      apiBaseUrl: z.string().url().optional().describe("Optional EasyBilling API base URL, for example: https://billing.example.com"),
    },
    async ({ customerIdentifier, paymentGatewayType, redirectUrl, cancelUrl, token, apiBaseUrl }) => {
      const resolvedBaseUrl = resolveBillingApiBaseUrl(apiBaseUrl);
      const tokenToUse = token ?? cachedBillingToken;

      if (!resolvedBaseUrl) {
        return {
          content: [{ type: "text", text: "Missing API base URL. Provide 'apiBaseUrl' or set 'EB_BILLING_API_BASE_URL'." }],
        };
      }

      if (!tokenToUse) {
        return {
          content: [{ type: "text", text: "Missing token. Provide 'token' or call eb_billing_login first in the same MCP session." }],
        };
      }

      const endpoint = `${resolvedBaseUrl.replace(/\/$/, "")}/api/payment-methods`;

      try {
        const response = await secureFetch(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${tokenToUse}`,
            "content-type": "application/json",
            "trace-id": randomUUID(),
          },
          body: JSON.stringify({
            customerIdentifier,
            paymentGatewayType,
            redirectUrl,
            cancelUrl,
          }),
        });

        const contentType = response.headers.get("content-type") ?? "";
        const responseBody = contentType.includes("application/json") ? await response.json() : await response.text();

        if (!response.ok) {
          return {
            content: [{ type: "text", text: `Create payment method failed (${response.status}). Response: ${typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody)}` }],
          };
        }

        return {
          content: [{ type: "text", text: typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody) }],
        };
      } catch (error) {
        const errorMessage = formatRequestError(error);
        return {
          content: [{ type: "text", text: `Create payment method request error: ${errorMessage}` }],
        };
      }
    }
  );

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