(define-constant ERR-UNAUTHORIZED (err u100))
(define-constant ERR-INVALID-SPLIT (err u104))
(define-constant ERR-NO-SHARE (err u105))
(define-constant ERR-NO-SPLIT (err u106))
(define-constant ERR-INVALID-SHARE-TOTAL (err u120))
(define-constant ERR-INVALID-SHARE-AMOUNT (err u121))
(define-constant ERR-BILL-NOT-FOUND (err u122))
(define-constant ERR-GROUP-NOT-FOUND (err u123))
(define-constant ERR-MEMBER-NOT-IN-GROUP (err u124))
(define-constant ERR-SPLIT-ALREADY-EXISTS (err u125))
(define-constant ERR-SPLIT-NOT-FOUND (err u126))
(define-constant ERR-INVALID-SPLIT-TYPE (err u127))
(define-constant ERR-MAX-SHARES-EXCEEDED (err u128))
(define-constant ERR-TIMESTAMP-INVALID (err u129))

(define-data-var split-counter uint u0)
(define-data-var max-shares-per-bill uint u20)
(define-data-var default-split-type (string-ascii 10))
(define-data-var authority-contract (optional principal) none)

(define-map splits
  uint
  {
    bill-id: uint,
    group-id: uint,
    split-type: (string-ascii 10),
    shares: (list 20 { member: principal, share: uint }),
    total-shares: uint,
    timestamp: uint,
    creator: principal,
    approved: bool,
    approvals: (list 20 principal)
  }
)

(define-map split-history
  uint
  (list 100 {
    bill-id: uint,
    old-shares: (list 20 { member: principal, share: uint }),
    new-shares: (list 20 { member: principal, share: uint }),
    updater: principal,
    timestamp: uint
  })
)

(define-trait bill-trait
  (
    get-bill (uint) (response { group-id: uint, total-amount: uint } uint)
  )
)

(define-trait group-trait
  (
    get-group (uint) (response { members: (list 20 principal) } uint)
  )
)

(define-read-only (get-split (bill-id uint))
  (map-get? splits bill-id)
)

(define-read-only (get-split-history (split-id uint))
  (map-get? split-history split-id)
)

(define-read-only (calculate-owe (bill-id uint) (member principal) (bill-contract <bill-trait>))
  (match (contract-call? bill-contract get-bill bill-id)
    bill (match (map-get? splits bill-id)
      split (let ((shares (get shares split))
                  (total-amount (get total-amount bill))
                  (member-share (fold (lambda (s acc) (if (is-eq (get member s) member) (get share s) acc)) shares u0)))
              (if (> member-share u0)
                (ok (/ (* total-amount member-share) (get total-shares split)))
                (err ERR-NO-SHARE)))
      (err ERR-NO-SPLIT))
    (err ERR-BILL-NOT-FOUND))
)

(define-private (validate-split-type (stype (string-ascii 10)))
  (if (or (is-eq stype "even") (is-eq stype "custom") (is-eq stype "weighted"))
    (ok true)
    (err ERR-INVALID-SPLIT-TYPE))
)

(define-private (validate-shares (shares (list 20 { member: principal, share: uint })) (num-members uint))
  (if (> (len shares) (var-get max-shares-per-bill))
    (err ERR-MAX-SHARES-EXCEEDED)
    (let ((total-share (fold + (map (lambda (s) (get share s)) shares) u0)))
      (if (is-eq total-share u10000)
        (begin
          (if (is-eq (len shares) num-members)
            (ok true)
            (err ERR-INVALID-SHARE-AMOUNT)))
        (err ERR-INVALID-SHARE-TOTAL))))
)

(define-private (is-member-in-group (member principal) (members (list 20 principal)))
  (is-some (index-of members member))
)

(define-public (set-authority-contract (contract-principal principal))
  (begin
    (asserts! (is-none (var-get authority-contract)) (err u130))
    (var-set authority-contract (some contract-principal))
    (ok true))
)

(define-public (set-max-shares-per-bill (new-max uint))
  (begin
    (asserts! (is-some (var-get authority-contract)) (err u131))
    (var-set max-shares-per-bill new-max)
    (ok true))
)

(define-public (split-bill-evenly (bill-id uint) (bill-contract <bill-trait>) (group-contract <group-trait>))
  (let ((caller tx-sender)
        (split-type "even"))
    (try! (validate-split-type split-type))
    (match (contract-call? bill-contract get-bill bill-id)
      bill (let ((group-id (get group-id bill)))
        (match (contract-call? group-contract get-group group-id)
          group (if (is-member-in-group caller (get members group))
            (let ((members (get members group))
                  (num-members (len members))
                  (share-per (/ u10000 num-members))
                  (shares (map (lambda (m) { member: m, share: share-per }) members))
                  (new-split-id (var-get split-counter)))
              (asserts! (is-none (map-get? splits bill-id)) (err ERR-SPLIT-ALREADY-EXISTS))
              (map-set splits new-split-id
                {
                  bill-id: bill-id,
                  group-id: group-id,
                  split-type: split-type,
                  shares: shares,
                  total-shares: u10000,
                  timestamp: block-height,
                  creator: caller,
                  approved: false,
                  approvals: (list caller)
                })
              (var-set split-counter (+ new-split-id u1))
              (print { event: "even-split-created", split-id: new-split-id })
              (ok new-split-id))
            (err ERR-UNAUTHORIZED))
          (err ERR-GROUP-NOT-FOUND)))
      (err ERR-BILL-NOT-FOUND)))
)

(define-public (split-bill-custom (bill-id uint) (shares (list 20 { member: principal, share: uint })) (bill-contract <bill-trait>) (group-contract <group-trait>))
  (let ((caller tx-sender)
        (split-type "custom"))
    (try! (validate-split-type split-type))
    (match (contract-call? bill-contract get-bill bill-id)
      bill (let ((group-id (get group-id bill)))
        (match (contract-call? group-contract get-group group-id)
          group (if (is-member-in-group caller (get members group))
            (try! (validate-shares shares (len (get members group))))
            (let ((new-split-id (var-get split-counter)))
              (asserts! (is-none (map-get? splits bill-id)) (err ERR-SPLIT-ALREADY-EXISTS))
              (map-set splits new-split-id
                {
                  bill-id: bill-id,
                  group-id: group-id,
                  split-type: split-type,
                  shares: shares,
                  total-shares: u10000,
                  timestamp: block-height,
                  creator: caller,
                  approved: false,
                  approvals: (list caller)
                })
              (var-set split-counter (+ new-split-id u1))
              (print { event: "custom-split-created", split-id: new-split-id })
              (ok new-split-id))
            (err ERR-UNAUTHORIZED))
          (err ERR-GROUP-NOT-FOUND)))
      (err ERR-BILL-NOT-FOUND)))
)

(define-public (approve-split (split-id uint) (bill-contract <bill-trait>) (group-contract <group-trait>))
  (let ((caller tx-sender))
    (match (map-get? splits split-id)
      split (if (is-eq (get approved split) false)
        (match (contract-call? bill-contract get-bill (get bill-id split))
          bill (let ((group-id (get group-id bill)))
            (match (contract-call? group-contract get-group group-id)
              group (if (and (is-member-in-group caller (get members group))
                             (not (is-some (index-of (get approvals split) caller))))
                (let ((new-approvals (append (get approvals split) caller))
                      (num-approvals (len new-approvals))
                      (threshold (/ (* (len (get members group)) u70) u100)))
                  (if (>= num-approvals threshold)
                    (begin
                      (map-set splits split-id (merge split { approved: true }))
                      (print { event: "split-approved", split-id: split-id })
                      (ok true))
                    (begin
                      (map-set splits split-id (merge split { approvals: new-approvals }))
                      (ok false))))
                (err ERR-UNAUTHORIZED))
              (err ERR-GROUP-NOT-FOUND)))
          (err ERR-BILL-NOT-FOUND))
        (err u132))
      (err ERR-SPLIT-NOT-FOUND)))
)

(define-public (update-split-shares (split-id uint) (new-shares (list 20 { member: principal, share: uint })) (bill-contract <bill-trait>) (group-contract <group-trait>))
  (let ((caller tx-sender))
    (match (map-get? splits split-id)
      split (if (is-eq (get creator split) caller)
        (match (contract-call? bill-contract get-bill (get bill-id split))
          bill (let ((group-id (get group-id bill)))
            (match (contract-call? group-contract get-group group-id)
              group (try! (validate-shares new-shares (len (get members group))))
              (let ((old-shares (get shares split))
                    (history-entry {
                      bill-id: (get bill-id split),
                      old-shares: old-shares,
                      new-shares: new-shares,
                      updater: caller,
                      timestamp: block-height
                    })
                    (current-history (default-to (list) (map-get? split-history split-id))))
                (map-set splits split-id (merge split { shares: new-shares }))
                (map-set split-history split-id (append current-history history-entry))
                (print { event: "split-updated", split-id: split-id })
                (ok true))
              (err ERR-GROUP-NOT-FOUND)))
          (err ERR-BILL-NOT-FOUND))
        (err ERR-UNAUTHORIZED))
      (err ERR-SPLIT-NOT-FOUND)))
)