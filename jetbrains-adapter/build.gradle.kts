plugins {
    // 说明：使用 JetBrains 官方 Gradle 插件来构建 IntelliJ 平台插件。
    id("org.jetbrains.intellij") version "1.17.4"
    kotlin("jvm") version "1.9.25"
}

group = "cn.xiaoo.smartime"
version = "0.0.3"

repositories {
    mavenCentral()
}

intellij {
    // 说明：目标 IDE 版本可按需调整，先与较新稳定版对齐。
    version.set("2024.2")
    type.set("IC")
}

dependencies {
    implementation(kotlin("stdlib"))
}

tasks {
    patchPluginXml {
        sinceBuild.set("242")
        untilBuild.set("252.*")
        pluginDescription.set(
            """
            SmartIME JetBrains Adapter.
            该适配层负责监听 JetBrains 场景事件，并调用 Go Worker 执行输入法切换。
            """.trimIndent(),
        )
    }

    // 说明：为了保证发布包稳定，统一使用 Java 17。
    withType<JavaCompile> {
        sourceCompatibility = "17"
        targetCompatibility = "17"
        options.encoding = "UTF-8"
    }

    withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile> {
        kotlinOptions.jvmTarget = "17"
    }
}
