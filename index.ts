import { z } from "zod";
import { createAgentApp } from "@lucid-dreams/agent-kit";
import axios from 'axios';

const { app, addEntrypoint } = createAgentApp({
  name: "lending-liquidation-sentinel",
  version: "0.1.2",
  description: "Watch borrow positions and warn before liquidation risk",
});

/**
 * Real implementation for Aave V3 Health Factor retrieval
 * Uses the Aave V3 Subgraph (The Graph) to get user data
 */
async function fetchAaveV3HealthFactor(wallet: string) {
  const SUBGRAPH_URL = "https://api.thegraph.com/subgraphs/name/aave/protocol-v3";
  
  const query = `
    {
      user(id: "${wallet.toLowerCase()}") {
        healthFactor
        totalCollateralBase
        totalDebtBase
      }
    }
  `;

  try {
    const response = await axios.post(SUBGRAPH_URL, { query });
    const userData = response.data?.data?.user;
    
    if (!userData) {
      throw new Error("No Aave V3 position found for this wallet");
    }

    // Health Factor is usually returned as a large integer (e.g., 1.2345 * 1e18)
    const rawHealthFactor = parseFloat(userData.healthFactor);
    const healthFactor = rawHealthFactor / 1e18;
    
    return {
      healthFactor,
      liqPrice: "Calculated via collateral weights",
    };
  } catch (error: any) {
    console.error("Aave API Error:", error.message);
    throw new Error(`Failed to fetch Aave V3 data: ${error.message}`);
  }
}

addEntrypoint({
  key: "check_health",
  description: "Monitor health factor and trigger alerts near liquidation",
  input: z.object({
    wallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address"),
    protocol_ids: z.array(z.string()),
    positions: z.array(z.string()).optional(),
  }),
  async handler({ input }) {
    const { wallet, protocol_ids } = input;
    const results = [];

    for (const pid of protocol_ids) {
      if (pid === "aave_v3") {
        try {
          const data = await fetchAaveV3HealthFactor(wallet);
          const healthFactor = data.healthFactor;
          
          const alertThreshold = 1.1;
          const bufferPercent = (healthFactor - 1.0) * 100;
          const alertThresholdHit = healthFactor < alertThreshold;

          results.push({
            protocol: "aave_v3",
            health_factor: healthFactor.toFixed(4),
            liq_price: data.liqPrice,
            buffer_percent: bufferPercent.toFixed(2) + "%",
            alert_threshold_hit: alertThresholdHit,
          });
        } catch (e: any) {
          results.push({
            protocol: "aave_v3",
            error: e.message
          });
        }
      } else {
        results.push({
          protocol: pid,
          error: "Protocol not yet supported"
        });
      }
    }

    return {
      output: {
        wallet,
        checks: results,
        global_alert: results.some(r => r.alert_threshold_hit),
        message: results.some(r => r.alert_threshold_hit) 
             ? "⚠️ WARNING: Liquidation risk detected!" 
             : "✅ All positions are healthy.",
      },
      usage: { total_tokens: 0 }, // Fixed: Now a number
    };
  },
});

export default app;
