/** ABI of contracts/src/BatchPayout.sol (payout + BatchPaid). */
export const batchPayoutAbi = [
  {
    type: "function",
    name: "payout",
    stateMutability: "nonpayable",
    inputs: [
      { name: "batchRef", type: "bytes32" },
      { name: "token", type: "address" },
      { name: "recipients", type: "address[]" },
      { name: "amounts", type: "uint256[]" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "BatchPaid",
    anonymous: false,
    inputs: [
      { name: "batchRef", type: "bytes32", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "payer", type: "address", indexed: true },
      { name: "total", type: "uint256", indexed: false },
      { name: "count", type: "uint256", indexed: false },
    ],
  },
] as const;
