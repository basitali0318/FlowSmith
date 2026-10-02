export interface Sample {
  id: string;
  title: string;
  kind: 'SOP' | 'Meeting notes' | 'Description';
  text: string;
}

export const SAMPLES: Sample[] = [
  {
    id: 'expense',
    title: 'Expense reimbursement',
    kind: 'SOP',
    text: `Expense Reimbursement Process

1. The employee submits an expense report with receipts.
2. The line manager reviews the report. If the amount exceeds $500, the department head also approves it. Otherwise, the process continues.
3. The finance clerk verifies the receipts against company policy.
4. If the receipts are invalid, the clerk rejects the claim and the process ends.
5. The finance clerk checks the budget availability.
6. The finance clerk schedules the payment.
7. The finance clerk records the payment in the ERP.
8. The system sends a confirmation email to the employee.`,
  },
  {
    id: 'loan',
    title: 'Loan application',
    kind: 'Description',
    text: `Loan Application Process

When a customer applies for a loan, the loan officer checks the application for completeness. If the application is incomplete, the loan officer returns it to the customer and the customer resubmits the documents. Otherwise, the credit analyst assesses the credit score.
The credit analyst calculates the risk rating. If the risk is high, the underwriter reviews the case manually and the manager approves the exception. Otherwise, the system approves the loan automatically.
If the loan is declined, the loan officer notifies the customer and the process ends.
The loan officer prepares the contract. The customer signs the contract. Then the finance team disburses the funds.`,
  },
  {
    id: 'onboarding',
    title: 'Employee onboarding',
    kind: 'Meeting notes',
    text: `Employee Onboarding

Notes from the HR sync:
- HR creates the employee record after the offer is accepted.
- The IT team provisions the laptop and accounts while the facilities team prepares the desk.
- The manager schedules the orientation session.
- The new hire completes the compliance training.
- HR reviews the signed documents.
- If documents are missing, HR requests them from the new hire. Otherwise, the manager confirms the probation plan.`,
  },
];
