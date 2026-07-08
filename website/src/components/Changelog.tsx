export default function Changelog() {
  return (
    <section id="dsh-changelog" className="section">
      <div className="wrap sec-in">
        <div className="eyebrow">changelog</div>
        <h2 className="h2">Release history</h2>
        <div className="cl-row cl-first">
          <div className="cl-ver">
            <div className="cl-ver-line">
              <span className="cl-tag">v0.1.0</span>
              <span className="cl-latest">latest</span>
            </div>
            <div className="cl-date">jul 2026</div>
          </div>
          <div className="cl-body">
            <div className="cl-title">Initial release</div>
            <ul className="cl-list">
              <li>
                SSH, SFTP, FTP and serial — all in-process (russh · russh-sftp
                · suppaftp · serialport)
              </li>
              <li>
                Tabbed workspace with split pane; terminals survive tab
                switches
              </li>
              <li>Saved connection profiles with groups</li>
              <li>
                Quick command chips, Ctrl+K compose bar, broadcast to all
                connected hosts
              </li>
              <li>
                Buffer search (Ctrl+F), session logging, ANSI highlight rules
              </li>
              <li>SSH port forwarding (tunnels)</li>
            </ul>
          </div>
        </div>
        <div className="cl-row cl-next">
          <div className="cl-unrel-ver">unreleased</div>
          <div className="cl-unrel-body">
            known-hosts verification (host keys are currently
            trust-on-first-use) · in-app update download
          </div>
        </div>
      </div>
    </section>
  );
}
