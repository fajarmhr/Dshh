export default function Docs({ fileName }: { fileName: string }) {
  return (
    <section id="dsh-docs" className="section">
      <div className="wrap sec-in">
        <div className="eyebrow">docs</div>
        <h2 className="h2">Up and running in 30 seconds</h2>
        <div className="grid-dl">
          <div className="doc-card">
            <div className="doc-title">Quickstart</div>
            <div className="qs">
              <div className="qs-step">
                <span className="qs-num">01</span>
                <span className="qs-txt">
                  download <span className="qs-strong">{fileName}</span>
                </span>
              </div>
              <div className="qs-step">
                <span className="qs-num">02</span>
                <span className="qs-txt">
                  extract anywhere — a USB stick works
                </span>
              </div>
              <div className="qs-step">
                <span className="qs-num">03</span>
                <span className="qs-txt">
                  run <span className="qs-strong">dshh.exe</span> and add your
                  first host with <span className="kbd-inline">+</span>
                </span>
              </div>
            </div>
            <div className="doc-note">
              No installer, no admin rights, no services. Windows SmartScreen
              may ask once — the exe is unsigned for now.
            </div>
          </div>
          <div className="doc-card">
            <div className="doc-title">Keyboard &amp; commands</div>
            <div className="keys">
              <div className="key-row">
                <span className="kbd">Ctrl + K</span>
                <span className="key-desc">
                  focus the compose bar from anywhere
                </span>
              </div>
              <div className="key-row">
                <span className="kbd">Ctrl + F</span>
                <span className="key-desc">search the terminal buffer</span>
              </div>
              <div className="key-row">
                <span className="kbd">Enter</span>
                <span className="key-desc">
                  run the composed command in the active tab
                </span>
              </div>
              <div className="key-row key-row-last">
                <span className="kbd">broadcast</span>
                <span className="key-desc">
                  toggle to send one command to every connected host
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
