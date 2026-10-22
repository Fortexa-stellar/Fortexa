import { AuditPage } from "@/types/audit";

/**
 * Mock function to simulate fetching audit pages
 * In a real implementation, this would call your API
 */
export async function getAuditPages(page: number, limit: number): Promise<AuditPage> {
  // This is a mock implementation
  // Replace with actual API call in production
  const mockPages: AuditPage[] = [
    {
      rows: [
        {
          id: "1",
          timestamp: "2026-09-30T10:00:00Z",
          action: "login",
          details: { user: "alice", method: "password" },
          hash: "a1b2c3",
          previousHash: "",
        },
        {
          id: "2",
          timestamp: "2026-09-30T10:05:00Z",
          action: "update",
          details: { field: "profile", secret: "sensitive-data" },
          hash: "d4e5f6",
          previousHash: "a1b2c3",
        },
      ],
      nextPage: 1,
    },
    {
      rows: [
        {
          id: "3",
          timestamp: "2026-09-30T10:10:00Z",
          action: "delete",
          details: { item: "document" },
          hash: "g7h8i9",
          previousHash: "d4e5f6",
        },
        {
          id: "4",
          timestamp: "2026-09-30T10:15:00Z",
          action: "create",
          details: { type: "note" },
          hash: "j0k1l2",
          previousHash: "WRONG_HASH", // This breaks the chain
        },
      ],
      nextPage: 2,
    },
    {
      rows: [
        {
          id: "5",
          timestamp: "2026-09-30T10:20:00Z",
          action: "logout",
          details: { user: "alice" },
          hash: "m3n4o5",
          previousHash: "j0k1l2",
        },
      ],
      nextPage: null,
    },
  ];

  return mockPages[page] || { rows: [], nextPage: null };
}
