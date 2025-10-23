(define-constant ERR-NOT-AUTHORIZED u100)
(define-constant ERR-GROUP-NOT-FOUND u102)
(define-constant ERR-INVALID-AMOUNT u103)
(define-constant ERR-INVALID-DESCRIPTION u104)
(define-constant ERR-INVALID-DUE-DATE u105)
(define-constant ERR-INVALID-CURRENCY u106)
(define-constant ERR-BILL-NOT-FOUND u107)
(define-constant ERR-BILL-CLOSED u108)
(define-constant ERR-INVALID-CATEGORY u109)
(define-constant ERR-AUTHORITY-NOT-VERIFIED u110)
(define-constant ERR-INVALID-MAX-SPLIT u111)
(define-constant ERR-INVALID-TAX-RATE u112)

(define-data-var bill-counter uint u0)
(define-data-var authority-contract (optional principal) none)
(define-data-var creation-fee uint u1000)
(define-data-var max-bills uint u10000)

(define-trait group-trait
  ((get-group (uint) (response { members: (list 50 principal) } uint))))

(define-map bills
  uint
  {
    group-id: uint,
    creator: principal,
    description: (string-utf8 100),
    total-amount: uint,
    created-at: uint,
    due-date: uint,
    currency: (string-utf8 20),
    status: bool,
    category: (string-utf8 50),
    max-split: uint,
    tax-rate: uint
  }
)

(define-map bill-metadata
  uint
  {
    creator: principal,
    created-at: uint,
    updated-at: uint
  }
)

(define-read-only (get-bill (bill-id uint))
  (map-get? bills bill-id)
)

(define-read-only (get-bill-metadata (bill-id uint))
  (map-get? bill-metadata bill-id)
)

(define-read-only (get-bill-count)
  (ok (var-get bill-counter))
)

(define-private (validate-description (desc (string-utf8 100)))
  (if (and (> (len desc) u0) (<= (len desc) u100))
      (ok true)
      (err ERR-INVALID-DESCRIPTION))
)

(define-private (validate-amount (amount uint))
  (if (> amount u0)
      (ok true)
      (err ERR-INVALID-AMOUNT))
)

(define-private (validate-due-date (due uint))
  (if (>= due block-height)
      (ok true)
      (err ERR-INVALID-DUE-DATE))
)

(define-private (validate-currency (cur (string-utf8 20)))
  (if (or (is-eq cur u"STX") (is-eq cur u"USD") (is-eq cur u"BTC"))
      (ok true)
      (err ERR-INVALID-CURRENCY))
)

(define-private (validate-category (cat (string-utf8 50)))
  (if (or (is-eq cat u"dinner") (is-eq cat u"travel") (is-eq cat u"event") (is-eq cat u"other"))
      (ok true)
      (err ERR-INVALID-CATEGORY))
)

(define-private (validate-max-split (max-split uint))
  (if (and (> max-split u0) (<= max-split u50))
      (ok true)
      (err ERR-INVALID-MAX-SPLIT))
)

(define-private (validate-tax-rate (rate uint))
  (if (<= rate u20)
      (ok true)
      (err ERR-INVALID-TAX-RATE))
)

(define-public (set-authority-contract (contract-principal principal))
  (begin
    (asserts! (is-none (var-get authority-contract)) (err ERR-AUTHORITY-NOT-VERIFIED))
    (asserts! (not (is-eq contract-principal 'SP000000000000000000002Q6VF78)) (err ERR-NOT-AUTHORIZED))
    (var-set authority-contract (some contract-principal))
    (ok true)
  )
)

(define-public (set-creation-fee (new-fee uint))
  (begin
    (asserts! (is-some (var-get authority-contract)) (err ERR-AUTHORITY-NOT-VERIFIED))
    (var-set creation-fee new-fee)
    (ok true)
  )
)

(define-public (create-bill
  (group-id uint)
  (description (string-utf8 100))
  (total-amount uint)
  (due-date uint)
  (currency (string-utf8 20))
  (category (string-utf8 50))
  (max-split uint)
  (tax-rate uint)
  (group-contract <group-trait>)
)
  (let ((caller tx-sender)
        (bill-id (var-get bill-counter)))
    (asserts! (< bill-id (var-get max-bills)) (err u113))
    (try! (validate-description description))
    (try! (validate-amount total-amount))
    (try! (validate-due-date due-date))
    (try! (validate-currency currency))
    (try! (validate-category category))
    (try! (validate-max-split max-split))
    (try! (validate-tax-rate tax-rate))
    (match (contract-call? group-contract get-group group-id)
      group
      (begin
        (asserts! (is-some (index-of (get members group) caller)) (err ERR-NOT-AUTHORIZED))
        (try! (stx-transfer? (var-get creation-fee) caller (unwrap! (var-get authority-contract) (err ERR-AUTHORITY-NOT-VERIFIED))))
        (map-set bills bill-id
          {
            group-id: group-id,
            creator: caller,
            description: description,
            total-amount: total-amount,
            created-at: block-height,
            due-date: due-date,
            currency: currency,
            status: true,
            category: category,
            max-split: max-split,
            tax-rate: tax-rate
          }
        )
        (map-set bill-metadata bill-id
          {
            creator: caller,
            created-at: block-height,
            updated-at: block-height
          }
        )
        (var-set bill-counter (+ bill-id u1))
        (print { event: "bill-created", id: bill-id })
        (ok bill-id)
      )
      error (err ERR-GROUP-NOT-FOUND)
    )
  )
)

(define-public (update-bill
  (bill-id uint)
  (new-description (string-utf8 100))
  (new-total-amount uint)
  (new-due-date uint)
  (new-category (string-utf8 50))
)
  (let ((bill (map-get? bills bill-id)))
    (match bill
      b
      (begin
        (asserts! (is-eq (get creator b) tx-sender) (err ERR-NOT-AUTHORIZED))
        (asserts! (get status b) (err ERR-BILL-CLOSED))
        (try! (validate-description new-description))
        (try! (validate-amount new-total-amount))
        (try! (validate-due-date new-due-date))
        (try! (validate-category new-category))
        (map-set bills bill-id
          {
            group-id: (get group-id b),
            creator: (get creator b),
            description: new-description,
            total-amount: new-total-amount,
            created-at: (get created-at b),
            due-date: new-due-date,
            currency: (get currency b),
            status: (get status b),
            category: new-category,
            max-split: (get max-split b),
            tax-rate: (get tax-rate b)
          }
        )
        (map-set bill-metadata bill-id
          {
            creator: (get creator b),
            created-at: (get created-at b),
            updated-at: block-height
          }
        )
        (print { event: "bill-updated", id: bill-id })
        (ok true)
      )
      (err ERR-BILL-NOT-FOUND)
    )
  )
)

(define-public (close-bill (bill-id uint))
  (let ((bill (map-get? bills bill-id)))
    (match bill
      b
      (begin
        (asserts! (is-eq (get creator b) tx-sender) (err ERR-NOT-AUTHORIZED))
        (asserts! (get status b) (err ERR-BILL-CLOSED))
        (map-set bills bill-id
          (merge b { status: false })
        )
        (map-set bill-metadata bill-id
          (merge (unwrap-panic (map-get? bill-metadata bill-id))
            { updated-at: block-height }
          )
        )
        (print { event: "bill-closed", id: bill-id })
        (ok true)
      )
      (err ERR-BILL-NOT-FOUND)
    )
  )
)