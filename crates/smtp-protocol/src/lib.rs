//! Sans-I/O RFC 5321 SMTP protocol parser, framing buffer, and state machine.

pub mod parser;
pub mod response;
pub mod state;

pub use parser::{
    parse_command, DataFrameError, DataLineResult, MailParams, ParseError, SmtpCommand,
    SmtpFrameBuffer,
};
pub use response::SmtpResponse;
pub use state::{ProtocolStep, SessionConfig, SessionState, SmtpMachine};
