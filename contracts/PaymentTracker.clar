(define-constant ERR-UNAUTHORIZED u100)
(define-constant ERR-INSUFFICIENT-OWE u101)
(define-constant ERR-OVERPAYMENT-NOT-ALLOWED u102)
(define-constant ERR-PARTIAL-PAYMENT-EXCEEDS u103)
(define-constant ERR-BILL-NOT-FOUND u104)
(define-constant ERR-NO-SPLIT-DEFINED u105)
(define-constant ERR-PAYMENT-ALREADY-SETTLED u106)
(define-constant ERR-INVALID-AMOUNT u107)
(define-constant ERR-TRANSFER-FAILED u108)
(define-constant ERR-REFUND-FAILED u109)
(define-constant ERR-INVALID-REFUND-AMOUNT u110)
(define-constant ERR-GROUP-NOT-FOUND u111)
(define-constant ERR-MAX-PAYMENTS-EXCEEDED u112)
(define-constant ERR-INVALID-STATUS u113)
(define-constant ERR-TIMESTAMP-INVALID u114)
(define-constant ERR-ADMIN-NOT-AUTHORIZED u115)

(define-data-var admin principal tx-sender)
(define-data-var payment-fee uint u10)
(define-data-var max-payments-per-bill uint u100)
(define-data-var settlement-threshold uint u95)

(define-trait split-trait
  (
    (calculate-owe (uint principal) (response uint uint))
    (get-split (uint) (response (optional (list 20 { member: principal, share: uint })) uint))
  )
)

(define-trait token-trait
  (
    (transfer (uint principal principal (optional (buff 34))) (response bool uint))
    (get-balance (principal) (response uint uint))
  )
)

(define-trait group-trait
  (
    (get-group (uint) (response { members: (list 20 principal) } uint))
  )
)

(define-map payments
  uint
  {
    bill-id: uint,
    payer: principal,
    amount: uint,
    timestamp: uint,
    status: (string-ascii 20),
    fee-deducted: uint
  }
)

(define-map bill-balances
  uint
  {
    total-owed: uint,
    total-paid: uint,
    settled: bool,
    last-updated: uint,
    group-id: uint
  }
)

(define-map payment-history
  { bill-id: uint, payer: principal }
  (list 50 uint)
)

(define-map refunds
  uint
  {
    bill-id: uint,
    payer: principal,
    amount: uint,
    reason: (string-ascii 100),
    timestamp: uint
  }
)

(define-read-only (get-payment (bill-id uint) (payer principal))
  (map-get? payments { bill-id: bill-id, payer: payer })
)

(define-read-only (get-bill-balance (bill-id uint))
  (map-get? bill-balances bill-id)
)

(define-read-only (get-payment-history (bill-id uint) (payer principal))
  (map-get? payment-history { bill-id: bill-id, payer: payer })
)

(define-read-only (get-refunds (refund-id uint))
  (map-get? refunds refund-id)
)

(define-read-only (is-bill-settled (bill-id uint))
  (match (map-get? bill-balances bill-id)
    balance (get settled balance)
    false
  )
)

(define-private (validate-amount (amount uint))
  (if (> amount u0)
      (ok true)
      (err ERR-INVALID-AMOUNT))
)

(define-private (validate-timestamp (ts uint))
  (if (>= ts block-height)
      (ok true)
      (err ERR-TIMESTAMP-INVALID))
)

(define-private (calculate-fee (amount uint))
  (/ (* amount (var-get payment-fee)) u100)
)

(define-private (update-bill-balance (bill-id uint) (amount uint) (is-add bool))
  (match (map-get? bill-balances bill-id)
    balance
      (let (
        (new-total-paid
          (if is-add
              (+ (get total-paid balance) amount)
              (- (get total-paid balance) amount)
          )
        )
        (new-settled
          (if (>= (/ (* new-total-paid u100) (get total-owed balance)) (var-get settlement-threshold))
              true
              (get settled balance)
          )
        )
      )
      (map-set bill-balances bill-id
        {
          total-owed: (get total-owed balance),
          total-paid: new-total-paid,
          settled: new-settled,
          last-updated: block-height,
          group-id: (get group-id balance)
        }
      )
      (ok true)
    )
    (err ERR-BILL-NOT-FOUND)
  )
)

(define-public (initialize-bill-balance (bill-id uint) (total-owed uint) (group-id uint) (split-contract <split-trait>) (group-contract <group-trait>))
  (let ((caller tx-sender))
    (asserts! (is-eq caller (var-get admin)) (err ERR-ADMIN-NOT-AUTHORIZED))
    (try! (validate-amount total-owed))
    (match (contract-call? split-contract get-split bill-id)
      split (begin
        (match (contract-call? group-contract get-group group-id)
          group (begin
            (map-set bill-balances bill-id
              {
                total-owed: total-owed,
                total-paid: u0,
                settled: false,
                last-updated: block-height,
                group-id: group-id
              }
            )
            (ok true)
          )
          error error
        )
      )
      (err ERR-NO-SPLIT-DEFINED)
    )
  )
)

(define-public (make-payment (bill-id uint) (amount uint) (token-contract <token-trait>) (split-contract <split-trait>))
  (let* (
    (caller tx-sender)
    (fee (calculate-fee amount))
    (net-amount (- amount fee))
    (owe-result (contract-call? split-contract calculate-owe bill-id caller))
  )
    (asserts! (is-ok owe-result) (err ERR-NO-SPLIT-DEFINED))
    (let ((owe (unwrap-panic owe-result)))
      (asserts! (<= net-amount owe) (err ERR-INSUFFICIENT-OWE))
      (asserts! (is-none (map-get? payments { bill-id: bill-id, payer: caller })) (err ERR-PAYMENT-ALREADY-SETTLED))
      (try! (validate-amount amount))
      (try! (contract-call? token-contract transfer amount caller (as-contract tx-sender) none))
      (try! (update-bill-balance bill-id net-amount true))
      (let ((payment-id (hash160 (concat (to-consensus-buff? bill-id) (to-consensus-buff? block-height)))))
        (map-set payments payment-id
          {
            bill-id: bill-id,
            payer: caller,
            amount: net-amount,
            timestamp: block-height,
            status: "settled",
            fee-deducted: fee
          }
        )
        (let ((history (default-to (list) (map-get? payment-history { bill-id: bill-id, payer: caller }))))
          (if (<= (len history) (var-get max-payments-per-bill))
              (map-set payment-history { bill-id: bill-id, payer: caller } (append history payment-id))
              (err ERR-MAX-PAYMENTS-EXCEEDED)
          )
        )
        (print { event: "payment-made", bill-id: bill-id, payer: caller, amount: net-amount })
        (ok payment-id)
      )
    )
  )
)

(define-public (make-partial-payment (bill-id uint) (amount uint) (token-contract <token-trait>) (split-contract <split-trait>))
  (let* (
    (caller tx-sender)
    (fee (calculate-fee amount))
    (net-amount (- amount fee))
    (owe-result (contract-call? split-contract calculate-owe bill-id caller))
    (current-paid (default-to u0 (get total-paid (unwrap-panic (map-get? bill-balances bill-id)))))
  )
    (asserts! (is-ok owe-result) (err ERR-NO-SPLIT-DEFINED))
    (let ((owe (unwrap-panic owe-result)))
      (asserts! (> net-amount u0) (err ERR-INVALID-AMOUNT))
      (asserts! (<= (+ current-paid net-amount) owe) (err ERR-PARTIAL-PAYMENT-EXCEEDS))
      (try! (contract-call? token-contract transfer amount caller (as-contract tx-sender) none))
      (try! (update-bill-balance bill-id net-amount true))
      (let ((payment-id (hash160 (concat (to-consensus-buff? bill-id) (to-consensus-buff? (+ block-height u1))))))
        (map-set payments payment-id
          {
            bill-id: bill-id,
            payer: caller,
            amount: net-amount,
            timestamp: block-height,
            status: "partial",
            fee-deducted: fee
          }
        )
        (let ((history (default-to (list) (map-get? payment-history { bill-id: bill-id, payer: caller }))))
          (map-set payment-history { bill-id: bill-id, payer: caller } (append history payment-id))
        )
        (print { event: "partial-payment", bill-id: bill-id, payer: caller, amount: net-amount })
        (ok payment-id)
      )
    )
  )
)

(define-public (request-refund (bill-id uint) (amount uint) (reason (string-ascii 100)) (token-contract <token-trait>))
  (let ((caller tx-sender))
    (try! (validate-amount amount))
    (asserts! (is-some (map-get? payments { bill-id: bill-id, payer: caller })) (err ERR-UNAUTHORIZED))
    (let ((refund-id (hash160 (concat (to-consensus-buff? bill-id) (to-consensus-buff? (+ block-height u2))))))
      (map-set refunds refund-id
        {
          bill-id: bill-id,
          payer: caller,
          amount: amount,
          reason: reason,
          timestamp: block-height
        }
      )
      (try! (contract-call? token-contract transfer amount (as-contract tx-sender) caller none))
      (try! (update-bill-balance bill-id amount false))
      (print { event: "refund-requested", refund-id: refund-id, bill-id: bill-id, amount: amount })
      (ok refund-id)
    )
  )
)

(define-public (settle-bill (bill-id uint) (split-contract <split-trait>))
  (let ((caller tx-sender))
    (asserts! (is-eq caller (var-get admin)) (err ERR-ADMIN-NOT-AUTHORIZED))
    (asserts! (is-ok (contract-call? split-contract get-split bill-id)) (err ERR-NO-SPLIT-DEFINED))
    (match (map-get? bill-balances bill-id)
      balance
        (if (get settled balance)
            (err ERR-PAYMENT-ALREADY-SETTLED)
            (begin
              (map-set bill-balances bill-id (merge balance { settled: true }))
              (ok true)
            )
        )
      (err ERR-BILL-NOT-FOUND)
    )
  )
)

(define-public (set-admin (new-admin principal))
  (asserts! (is-eq tx-sender (var-get admin)) (err ERR-ADMIN-NOT-AUTHORIZED))
  (var-set admin new-admin)
  (ok true)
)

(define-public (set-payment-fee (new-fee uint))
  (asserts! (is-eq tx-sender (var-get admin)) (err ERR-ADMIN-NOT-AUTHORIZED))
  (var-set payment-fee new-fee)
  (ok true)
)

(define-public (set-max-payments-per-bill (new-max uint))
  (asserts! (is-eq tx-sender (var-get admin)) (err ERR-ADMIN-NOT-AUTHORIZED))
  (var-set max-payments-per-bill new-max)
  (ok true)
)

(define-public (set-settlement-threshold (new-threshold uint))
  (asserts! (is-eq tx-sender (var-get admin)) (err ERR-ADMIN-NOT-AUTHORIZED))
  (var-set settlement-threshold new-threshold)
  (ok true)
)