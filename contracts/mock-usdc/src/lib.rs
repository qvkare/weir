//! A NEP-141 test dollar, `tUSDC`, 6 decimals, with an open faucet: anyone may mint
//! any amount to anyone. For testnet and tests only. It is worth nothing.
//!
//! Storage follows NEP-145 with a fixed price, so wallets can register accounts.
//! `mint` registers its recipient for free, which a real token would not do.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, NearToken, PromiseOrValue,
};

/// What one account record costs to store, with room to spare.
pub const STORAGE_DEPOSIT: NearToken = NearToken::from_micronear(1_250);
const RESOLVE_GAS: Gas = Gas::from_tgas(5);
const ON_TRANSFER_GAS: Gas = Gas::from_tgas(5);

pub const ERR_ONE_YOCTO: &str = "requires exactly 1 yoctoNEAR attached";
pub const ERR_NOT_REGISTERED: &str = "account is not registered";
pub const ERR_BALANCE: &str = "balance is too low";
pub const ERR_ZERO_AMOUNT: &str = "amount must be above zero";
pub const ERR_SELF_TRANSFER: &str = "sender and receiver must differ";
pub const ERR_DEPOSIT: &str = "attached deposit is below the storage minimum";
pub const ERR_OVERFLOW: &str = "arithmetic overflow";

#[ext_contract(ext_receiver)]
#[allow(dead_code)]
trait FungibleTokenReceiver {
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128;
}

#[near(serializers = [json])]
pub struct FungibleTokenMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
    pub decimals: u8,
}

#[near(serializers = [json])]
pub struct StorageBalance {
    pub total: NearToken,
    pub available: NearToken,
}

#[near(serializers = [json])]
pub struct StorageBalanceBounds {
    pub min: NearToken,
    pub max: Option<NearToken>,
}

#[near(contract_state)]
pub struct MockUsdc {
    balances: LookupMap<AccountId, u128>,
    total_supply: u128,
}

impl Default for MockUsdc {
    fn default() -> Self {
        Self {
            balances: LookupMap::new(b"b"),
            total_supply: 0,
        }
    }
}

fn require_one_yocto() {
    require!(
        env::attached_deposit() == NearToken::from_yoctonear(1),
        ERR_ONE_YOCTO
    );
}

fn log_event(event: &str, data: serde_json::Value) {
    let event = json!({ "standard": "nep141", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{event}"));
}

#[near]
impl MockUsdc {
    /// The faucet. Registers `account_id` if needed.
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(amount.0 > 0, ERR_ZERO_AMOUNT);
        let balance = self.balances.entry(account_id.clone()).or_insert(0);
        *balance = balance
            .checked_add(amount.0)
            .unwrap_or_else(|| env::panic_str(ERR_OVERFLOW));
        self.total_supply = self
            .total_supply
            .checked_add(amount.0)
            .unwrap_or_else(|| env::panic_str(ERR_OVERFLOW));
        log_event(
            "ft_mint",
            json!({ "owner_id": account_id, "amount": amount }),
        );
    }

    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        require_one_yocto();
        let sender_id = env::predecessor_account_id();
        self.transfer(&sender_id, &receiver_id, amount.0, memo);
    }

    #[payable]
    pub fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require_one_yocto();
        let sender_id = env::predecessor_account_id();
        self.transfer(&sender_id, &receiver_id, amount.0, memo);
        ext_receiver::ext(receiver_id.clone())
            .with_static_gas(ON_TRANSFER_GAS)
            .with_unused_gas_weight(1)
            .ft_on_transfer(sender_id.clone(), amount, msg)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(RESOLVE_GAS)
                    .with_unused_gas_weight(0)
                    .ft_resolve_transfer(sender_id, receiver_id, amount),
            )
            .into()
    }

    /// Returns what the receiver kept. A failed or unreadable `ft_on_transfer`
    /// refunds everything, as NEP-141 says.
    #[private]
    pub fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let unused = match env::promise_result_checked(0, 100) {
            Ok(bytes) => serde_json::from_slice::<U128>(&bytes)
                .map(|unused| unused.0.min(amount.0))
                .unwrap_or(amount.0),
            Err(_) => amount.0,
        };
        let receiver_balance = self.balances.get(&receiver_id).copied().unwrap_or(0);
        let refund = unused.min(receiver_balance);
        if refund > 0 {
            self.balances.insert(receiver_id.clone(), receiver_balance - refund);
            match self.balances.get_mut(&sender_id) {
                Some(balance) => *balance += refund,
                // The sender left; the refund is burned.
                None => self.total_supply -= refund,
            }
            log_event(
                "ft_transfer",
                json!({ "old_owner_id": receiver_id, "new_owner_id": sender_id, "amount": U128(refund), "memo": "refund" }),
            );
        }
        U128(amount.0 - refund)
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.balances.get(&account_id).copied().unwrap_or(0))
    }

    pub fn ft_total_supply(&self) -> U128 {
        U128(self.total_supply)
    }

    pub fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: "ft-1.0.0".into(),
            name: "Test USDC (no value)".into(),
            symbol: "tUSDC".into(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        }
    }

    /// NEP-145. Registering twice refunds the whole deposit.
    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        let _ = registration_only;
        let deposit = env::attached_deposit();
        let payer = env::predecessor_account_id();
        let account_id = account_id.unwrap_or_else(|| payer.clone());
        let refund = if self.balances.contains_key(&account_id) {
            deposit
        } else {
            require!(deposit >= STORAGE_DEPOSIT, ERR_DEPOSIT);
            self.balances.insert(account_id, 0);
            deposit.saturating_sub(STORAGE_DEPOSIT)
        };
        if !refund.is_zero() {
            near_sdk::Promise::new(payer).transfer(refund).detach();
        }
        Self::storage_balance()
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.balances
            .contains_key(&account_id)
            .then(Self::storage_balance)
    }

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds {
            min: STORAGE_DEPOSIT,
            max: Some(STORAGE_DEPOSIT),
        }
    }
}

impl MockUsdc {
    fn storage_balance() -> StorageBalance {
        StorageBalance {
            total: STORAGE_DEPOSIT,
            available: NearToken::from_yoctonear(0),
        }
    }

    fn transfer(&mut self, sender_id: &AccountId, receiver_id: &AccountId, amount: u128, memo: Option<String>) {
        require!(amount > 0, ERR_ZERO_AMOUNT);
        require!(sender_id != receiver_id, ERR_SELF_TRANSFER);
        require!(self.balances.contains_key(receiver_id), ERR_NOT_REGISTERED);
        let sender = self
            .balances
            .get_mut(sender_id)
            .unwrap_or_else(|| env::panic_str(ERR_NOT_REGISTERED));
        *sender = sender
            .checked_sub(amount)
            .unwrap_or_else(|| env::panic_str(ERR_BALANCE));
        let receiver = self.balances.get_mut(receiver_id).unwrap();
        *receiver = receiver
            .checked_add(amount)
            .unwrap_or_else(|| env::panic_str(ERR_OVERFLOW));
        log_event(
            "ft_transfer",
            json!({ "old_owner_id": sender_id, "new_owner_id": receiver_id, "amount": U128(amount), "memo": memo }),
        );
    }
}
