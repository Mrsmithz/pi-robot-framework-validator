*** Test Cases ***
TC-1 Successful checkout
    [Documentation]    The customer completes checkout.
    Given a customer with a cart
    When the customer completes checkout
    Then the order is confirmed
