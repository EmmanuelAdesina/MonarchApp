# MonarchApp Upgrade Tasks

## Objective
Implement the new Monarch Wealth Group financial policy upgrades: $500 minimum deposit, $1,000 minimum withdrawal, crypto wallet payout flow, monthly withdrawal cycles with 25th cut-off, and improved admin payout controls.

## Tasks
1. Update landing page and dashboard deposit copy to show minimum deposit of $500.
2. Update dashboard withdrawal UI to show minimum withdrawal of $1,000, withdrawal cycle dates, countdown timer, and wallet payout form.
3. Add frontend wallet save form and ensure wallet address/network are stored before withdrawal requests.
4. Enforce withdrawal window restrictions between the 1st and 25th on backend and frontend.
5. Add backend month-end auto-approval for pending withdrawals on the last day of the month.
6. Patch admin statistics endpoint to support current cycle tracking and auto-approval behavior.
7. Keep existing admin payout workflow intact and ensure wallet/network data is shown in admin withdrawal details.

## Notes
- Do not change the overall modal deposit flow unless required.
- Use existing wallet storage fields and crypto payout routes.
- Maintain the current admin approval path, while allowing monthly processing logic.
