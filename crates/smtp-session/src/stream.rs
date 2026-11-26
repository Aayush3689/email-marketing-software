//! Stream wrapper supporting both plain TCP and TLS (implicit or upgraded via STARTTLS).

use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio_rustls::server::TlsStream;

/// Async stream backing an SMTP session, upgradable in-place from plain TCP to TLS.
pub enum SessionStream<S> {
    Plain(S),
    Tls(Box<TlsStream<S>>),
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncRead for SessionStream<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(inner) => Pin::new(inner).poll_read(cx, buf),
            Self::Tls(inner) => Pin::new(inner.as_mut()).poll_read(cx, buf),
        }
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncWrite for SessionStream<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Plain(inner) => Pin::new(inner).poll_write(cx, buf),
            Self::Tls(inner) => Pin::new(inner.as_mut()).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(inner) => Pin::new(inner).poll_flush(cx),
            Self::Tls(inner) => Pin::new(inner.as_mut()).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(inner) => Pin::new(inner).poll_shutdown(cx),
            Self::Tls(inner) => Pin::new(inner.as_mut()).poll_shutdown(cx),
        }
    }
}
