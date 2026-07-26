export function AboutPage() {
  return (
    <div className="panel about-layout">
      <h2 style={{ marginTop: 0 }}>О программе</h2>
      <div className="about-card">
        <p>Приложение создано для работы пунктов связи пожарных подразделений</p>
        <p>Разработчик Русалеев А.В. г. Кемерово.</p>
        <p className="about-gap">По вопросам и предложениям</p>
        <p>
          Telegram: <strong>AlekseyRus42</strong>
        </p>
        <p>
          email: <a href="mailto:leshqa90@yandex.ru">leshqa90@yandex.ru</a>
        </p>
      </div>
    </div>
  );
}
